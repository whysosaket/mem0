/**
 * OpenClaw → Mem0 memory migration tool.
 *
 * Reads OpenClaw's native memory files (MEMORY.md, memory/*.md) and session
 * JSONL files, then ingests them into Mem0 via provider.add() which handles
 * LLM-based fact extraction, deduplication, and categorization.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, readdirSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";

import type {
  Mem0Provider,
  AddOptions,
  DiscoveredFile,
  MigrationState,
  MigrateOptions,
} from "./types.ts";
import { filterMessagesForExtraction } from "./filtering.ts";

// ============================================================================
// File Discovery
// ============================================================================

/**
 * Discover MEMORY.md and memory/*.md files in the workspace following
 * OpenClaw's standard directory layout (mirrors listMemoryFiles in
 * OpenClaw's src/memory/internal.ts).
 */
export function discoverMemoryFiles(workspacePath: string): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];

  // Check for MEMORY.md or memory.md in workspace root
  for (const name of ["MEMORY.md", "memory.md"]) {
    const absPath = join(workspacePath, name);
    if (existsSync(absPath)) {
      const stat = statSync(absPath);
      if (stat.isFile() && stat.size > 0) {
        files.push({
          path: absPath,
          relativePath: name,
          source: "memory",
          size: stat.size,
          hash: hashFile(absPath),
        });
      }
    }
  }

  // Walk memory/ directory recursively
  const memoryDir = join(workspacePath, "memory");
  if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
    walkDir(memoryDir, (absPath) => {
      if (extname(absPath).toLowerCase() !== ".md") return;
      const stat = statSync(absPath);
      if (!stat.isFile() || stat.size === 0) return;
      files.push({
        path: absPath,
        relativePath: relative(workspacePath, absPath),
        source: "memory",
        size: stat.size,
        hash: hashFile(absPath),
      });
    });
  }

  return files;
}

/**
 * Discover session JSONL files in the workspace. OpenClaw stores sessions
 * in a sessions/ or .sessions/ directory as .jsonl files.
 */
export function discoverSessionFiles(workspacePath: string): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];

  for (const dirName of ["sessions", ".sessions"]) {
    const sessionsDir = join(workspacePath, dirName);
    if (!existsSync(sessionsDir) || !statSync(sessionsDir).isDirectory()) continue;

    walkDir(sessionsDir, (absPath) => {
      if (extname(absPath).toLowerCase() !== ".jsonl") return;
      const stat = statSync(absPath);
      if (!stat.isFile() || stat.size === 0) return;
      files.push({
        path: absPath,
        relativePath: relative(workspacePath, absPath),
        source: "sessions",
        size: stat.size,
        hash: hashFile(absPath),
      });
    });
  }

  return files;
}

// ============================================================================
// File Parsers
// ============================================================================

/**
 * Parse a markdown memory file into message batches suitable for provider.add().
 * Chunks the file by paragraphs, keeping each batch under ~2000 chars.
 */
export function parseMarkdownFile(
  filePath: string,
  batchSize: number = 2000,
): Array<Array<{ role: string; content: string }>> {
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const fileName = basename(filePath);
  const chunks = chunkByParagraphs(content, batchSize);

  return chunks.map((chunk) => [
    {
      role: "user",
      content: `The following is from my personal notes file (${fileName}):\n\n${chunk}`,
    },
  ]);
}

/**
 * Parse a session JSONL file into message batches. Each batch is a window
 * of conversation messages grouped for context-aware extraction.
 */
export function parseSessionJsonl(
  filePath: string,
  windowSize: number = 20,
): Array<Array<{ role: string; content: string }>> {
  const raw = readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];

  const lines = raw.split("\n");
  const messages: Array<{ role: string; content: string }> = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type !== "message") continue;
    const msg = record.message;
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

    let textContent = "";
    if (typeof msg.content === "string") {
      textContent = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          textContent += (textContent ? "\n" : "") + block.text;
        }
      }
    }

    if (!textContent.trim()) continue;
    messages.push({ role: msg.role, content: textContent });
  }

  if (messages.length === 0) return [];

  // Group into conversation windows
  const batches: Array<Array<{ role: string; content: string }>> = [];
  for (let i = 0; i < messages.length; i += windowSize) {
    batches.push(messages.slice(i, i + windowSize));
  }

  return batches;
}

// ============================================================================
// State Management
// ============================================================================

export function loadMigrationState(stateFilePath: string): MigrationState | null {
  if (!existsSync(stateFilePath)) return null;
  try {
    const raw = readFileSync(stateFilePath, "utf-8");
    return JSON.parse(raw) as MigrationState;
  } catch {
    return null;
  }
}

export function saveMigrationState(stateFilePath: string, state: MigrationState): void {
  const tmpPath = stateFilePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, stateFilePath);
}

function freshState(): MigrationState {
  return {
    started_at: new Date().toISOString(),
    last_updated_at: new Date().toISOString(),
    migrated_files: {},
    total_files_processed: 0,
    total_memories_extracted: 0,
    total_errors: 0,
    error_files: [],
  };
}

// ============================================================================
// Core Migration
// ============================================================================

export interface MigrationLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error?(msg: string): void;
}

export async function runMigration(
  provider: Mem0Provider,
  options: MigrateOptions,
  buildAddOptions: (userIdOverride?: string) => AddOptions,
  logger: MigrationLogger,
  reset?: boolean,
): Promise<MigrationState> {
  const { workspacePath, source, batchSize, dryRun, delayMs, userId } = options;

  // 1. Discover files
  let files: DiscoveredFile[] = [];
  if (source === "memory" || source === "all") {
    files.push(...discoverMemoryFiles(workspacePath));
  }
  if (source === "sessions" || source === "all") {
    files.push(...discoverSessionFiles(workspacePath));
  }

  if (files.length === 0) {
    logger.info("openclaw-mem0 migrate: no files found to migrate.");
    return freshState();
  }

  logger.info(
    `openclaw-mem0 migrate: discovered ${files.length} files (${files.filter((f) => f.source === "memory").length} memory, ${files.filter((f) => f.source === "sessions").length} sessions)`,
  );

  // 2. Load or create state
  const stateFilePath = join(workspacePath, ".openclaw-mem0-migration.json");
  let state = reset ? null : loadMigrationState(stateFilePath);
  if (!state) {
    state = freshState();
  }

  // 3. Filter out already-migrated files (by path + hash)
  const pendingFiles = files.filter((f) => {
    const previousHash = state!.migrated_files[f.relativePath];
    return previousHash !== f.hash;
  });

  if (pendingFiles.length === 0) {
    logger.info("openclaw-mem0 migrate: all files already migrated. Use --reset to re-process.");
    return state;
  }

  logger.info(
    `openclaw-mem0 migrate: ${pendingFiles.length} files to process${dryRun ? " (dry run)" : ""}`,
  );

  // 4. Process each file
  for (const file of pendingFiles) {
    logger.info(`openclaw-mem0 migrate: processing ${file.relativePath} (${file.source})`);

    try {
      // Parse file into message batches
      const batches = file.source === "memory"
        ? parseMarkdownFile(file.path, batchSize)
        : parseSessionJsonl(file.path, batchSize);

      if (batches.length === 0) {
        logger.info(`openclaw-mem0 migrate: skipping ${file.relativePath} (no content)`);
        state.migrated_files[file.relativePath] = file.hash;
        state.total_files_processed++;
        saveMigrationState(stateFilePath, state);
        continue;
      }

      let fileMemories = 0;

      for (let i = 0; i < batches.length; i++) {
        // Apply noise filtering
        const filtered = filterMessagesForExtraction(batches[i]);
        if (filtered.length === 0) continue;

        // Skip if no user content remains
        if (!filtered.some((m) => m.role === "user")) continue;

        // Inject timestamp preamble for temporal anchoring
        const fileStat = statSync(file.path);
        const fileDate = new Date(fileStat.mtimeMs).toISOString().split("T")[0];
        filtered.unshift({
          role: "system",
          content: `Current date: ${fileDate}. Source file: ${file.relativePath}. Extract durable facts from this content.`,
        });

        if (dryRun) {
          logger.info(
            `openclaw-mem0 migrate: [dry-run] would send batch ${i + 1}/${batches.length} (${filtered.length} messages) from ${file.relativePath}`,
          );
          continue;
        }

        // Build add options with migration-specific source
        const addOpts = buildAddOptions(userId);
        addOpts.source = "OPENCLAW_MIGRATION";

        const result = await provider.add(filtered, addOpts);
        const extracted = result.results?.length ?? 0;
        fileMemories += extracted;

        logger.info(
          `openclaw-mem0 migrate: batch ${i + 1}/${batches.length} → ${extracted} memories extracted`,
        );

        // Rate limit delay between batches
        if (delayMs > 0 && i < batches.length - 1) {
          await sleep(delayMs);
        }
      }

      state.migrated_files[file.relativePath] = file.hash;
      state.total_files_processed++;
      state.total_memories_extracted += fileMemories;
      state.last_updated_at = new Date().toISOString();
      saveMigrationState(stateFilePath, state);

      logger.info(
        `openclaw-mem0 migrate: ${file.relativePath} done (${fileMemories} memories)`,
      );
    } catch (err) {
      state.total_errors++;
      if (!state.error_files.includes(file.relativePath)) {
        state.error_files.push(file.relativePath);
      }
      state.last_updated_at = new Date().toISOString();
      saveMigrationState(stateFilePath, state);

      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`openclaw-mem0 migrate: error processing ${file.relativePath}: ${errMsg}`);
    }
  }

  // 5. Print summary
  logger.info(
    [
      "\nopenclaw-mem0 migrate: complete.",
      `  Source:     ${source}`,
      `  Files:      ${state.total_files_processed} processed`,
      `  Memories:   ${state.total_memories_extracted} extracted`,
      `  Errors:     ${state.total_errors}`,
      `  State file: ${stateFilePath}`,
      dryRun ? "  Mode:       DRY RUN (no changes written)" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return state;
}

// ============================================================================
// Utilities
// ============================================================================

function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function walkDir(dir: string, callback: (path: string) => void): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

/**
 * Split text into chunks at paragraph boundaries, keeping each chunk
 * under maxChars. Falls back to splitting at line boundaries if a
 * single paragraph exceeds the limit.
 */
export function chunkByParagraphs(text: string, maxChars: number = 2000): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (!para.trim()) continue;

    if (current && (current.length + para.length + 2) > maxChars) {
      chunks.push(current.trim());
      current = "";
    }

    if (para.length > maxChars) {
      // Paragraph itself exceeds limit — split by lines
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      const lines = para.split("\n");
      for (const line of lines) {
        if (current && (current.length + line.length + 1) > maxChars) {
          chunks.push(current.trim());
          current = "";
        }
        current += (current ? "\n" : "") + line;
      }
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
