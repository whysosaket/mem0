/**
 * Tests for the OpenClaw → Mem0 memory migration tool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverMemoryFiles,
  discoverSessionFiles,
  parseMarkdownFile,
  parseSessionJsonl,
  chunkByParagraphs,
  loadMigrationState,
  saveMigrationState,
  runMigration,
} from "./migrate.ts";

import type { Mem0Provider, AddResult, MigrationState } from "./types.ts";

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mem0-migrate-test-"));
}

function mockProvider(addResult?: AddResult): Mem0Provider {
  return {
    add: vi.fn().mockResolvedValue(addResult ?? { results: [{ id: "m1", memory: "test fact", event: "ADD" }] }),
    search: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ id: "m1", memory: "test" }),
    getAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function mockBuildAddOptions(userId?: string) {
  return (userIdOverride?: string) => ({
    user_id: userIdOverride ?? userId ?? "test-user",
    source: "OPENCLAW",
  });
}

// ============================================================================
// chunkByParagraphs
// ============================================================================

describe("chunkByParagraphs", () => {
  it("returns a single chunk for short text", () => {
    const result = chunkByParagraphs("Hello world", 2000);
    expect(result).toEqual(["Hello world"]);
  });

  it("splits at paragraph boundaries", () => {
    const para1 = "A".repeat(1500);
    const para2 = "B".repeat(1500);
    const text = `${para1}\n\n${para2}`;
    const result = chunkByParagraphs(text, 2000);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(para1);
    expect(result[1]).toBe(para2);
  });

  it("keeps paragraphs together when under limit", () => {
    const text = "Short paragraph one.\n\nShort paragraph two.\n\nShort paragraph three.";
    const result = chunkByParagraphs(text, 2000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it("handles empty text", () => {
    expect(chunkByParagraphs("", 2000)).toEqual([]);
  });

  it("splits long single paragraphs by lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(100)}`);
    const text = lines.join("\n");
    const result = chunkByParagraphs(text, 500);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(600); // some slack for joining
    }
  });
});

// ============================================================================
// discoverMemoryFiles
// ============================================================================

describe("discoverMemoryFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds MEMORY.md in workspace root", () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "# My Notes\nSome content");
    const files = discoverMemoryFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe("MEMORY.md");
    expect(files[0].source).toBe("memory");
    expect(files[0].hash).toBeTruthy();
  });

  it("finds memory.md (lowercase) in workspace root", () => {
    writeFileSync(join(tmpDir, "memory.md"), "content");
    const files = discoverMemoryFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe("memory.md");
  });

  it("finds .md files in memory/ directory recursively", () => {
    mkdirSync(join(tmpDir, "memory"));
    mkdirSync(join(tmpDir, "memory", "sub"));
    writeFileSync(join(tmpDir, "memory", "notes.md"), "notes");
    writeFileSync(join(tmpDir, "memory", "sub", "deep.md"), "deep");
    const files = discoverMemoryFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      join("memory", "notes.md"),
      join("memory", "sub", "deep.md"),
    ]);
  });

  it("ignores non-.md files in memory/ directory", () => {
    mkdirSync(join(tmpDir, "memory"));
    writeFileSync(join(tmpDir, "memory", "notes.md"), "notes");
    writeFileSync(join(tmpDir, "memory", "data.json"), "{}");
    const files = discoverMemoryFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe(join("memory", "notes.md"));
  });

  it("returns empty array when no memory files exist", () => {
    expect(discoverMemoryFiles(tmpDir)).toEqual([]);
  });

  it("skips empty files", () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "");
    expect(discoverMemoryFiles(tmpDir)).toEqual([]);
  });
});

// ============================================================================
// discoverSessionFiles
// ============================================================================

describe("discoverSessionFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .jsonl files in sessions/ directory", () => {
    mkdirSync(join(tmpDir, "sessions"));
    writeFileSync(join(tmpDir, "sessions", "chat1.jsonl"), '{"type":"message"}\n');
    const files = discoverSessionFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].source).toBe("sessions");
    expect(files[0].relativePath).toBe(join("sessions", "chat1.jsonl"));
  });

  it("finds .jsonl files in .sessions/ directory", () => {
    mkdirSync(join(tmpDir, ".sessions"));
    writeFileSync(join(tmpDir, ".sessions", "chat2.jsonl"), '{"type":"message"}\n');
    const files = discoverSessionFiles(tmpDir);
    expect(files).toHaveLength(1);
  });

  it("returns empty when no session directories exist", () => {
    expect(discoverSessionFiles(tmpDir)).toEqual([]);
  });
});

// ============================================================================
// parseMarkdownFile
// ============================================================================

describe("parseMarkdownFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wraps content as user message with filename context", () => {
    const filePath = join(tmpDir, "MEMORY.md");
    writeFileSync(filePath, "I prefer dark mode. My timezone is PST.");
    const batches = parseMarkdownFile(filePath);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].role).toBe("user");
    expect(batches[0][0].content).toContain("MEMORY.md");
    expect(batches[0][0].content).toContain("dark mode");
  });

  it("returns empty for empty file", () => {
    const filePath = join(tmpDir, "empty.md");
    writeFileSync(filePath, "");
    expect(parseMarkdownFile(filePath)).toEqual([]);
  });

  it("chunks large files into multiple batches", () => {
    const filePath = join(tmpDir, "large.md");
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${"x".repeat(300)}`);
    writeFileSync(filePath, paras.join("\n\n"));
    const batches = parseMarkdownFile(filePath, 500);
    expect(batches.length).toBeGreaterThan(1);
  });
});

// ============================================================================
// parseSessionJsonl
// ============================================================================

describe("parseSessionJsonl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts user and assistant messages", () => {
    const filePath = join(tmpDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Hi there" } }),
    ];
    writeFileSync(filePath, lines.join("\n"));
    const batches = parseSessionJsonl(filePath);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][0]).toEqual({ role: "user", content: "Hello" });
    expect(batches[0][1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("skips non-message records", () => {
    const filePath = join(tmpDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "system_event", data: "something" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Real message" } }),
      JSON.stringify({ type: "tool_use", tool: "something" }),
    ];
    writeFileSync(filePath, lines.join("\n"));
    const batches = parseSessionJsonl(filePath);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].content).toBe("Real message");
  });

  it("handles array content blocks", () => {
    const filePath = join(tmpDir, "session.jsonl");
    const lines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Part one" },
            { type: "text", text: "Part two" },
          ],
        },
      }),
    ];
    writeFileSync(filePath, lines.join("\n"));
    const batches = parseSessionJsonl(filePath);
    expect(batches[0][0].content).toBe("Part one\nPart two");
  });

  it("groups messages into windows", () => {
    const filePath = join(tmpDir, "session.jsonl");
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ type: "message", message: { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` } }),
    );
    writeFileSync(filePath, lines.join("\n"));
    const batches = parseSessionJsonl(filePath, 10);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(10);
    expect(batches[1]).toHaveLength(10);
    expect(batches[2]).toHaveLength(10);
  });

  it("returns empty for empty file", () => {
    const filePath = join(tmpDir, "empty.jsonl");
    writeFileSync(filePath, "");
    expect(parseSessionJsonl(filePath)).toEqual([]);
  });

  it("skips invalid JSON lines gracefully", () => {
    const filePath = join(tmpDir, "bad.jsonl");
    const lines = [
      "not json at all",
      JSON.stringify({ type: "message", message: { role: "user", content: "valid" } }),
      "{broken json",
    ];
    writeFileSync(filePath, lines.join("\n"));
    const batches = parseSessionJsonl(filePath);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].content).toBe("valid");
  });
});

// ============================================================================
// Migration State
// ============================================================================

describe("migration state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for non-existent state file", () => {
    expect(loadMigrationState(join(tmpDir, "nope.json"))).toBeNull();
  });

  it("round-trips state through save/load", () => {
    const path = join(tmpDir, "state.json");
    const state: MigrationState = {
      started_at: "2026-01-01T00:00:00Z",
      last_updated_at: "2026-01-01T01:00:00Z",
      migrated_files: { "MEMORY.md": "abc123" },
      total_files_processed: 1,
      total_memories_extracted: 5,
      total_errors: 0,
      error_files: [],
    };
    saveMigrationState(path, state);
    const loaded = loadMigrationState(path);
    expect(loaded).toEqual(state);
  });

  it("returns null for corrupted state file", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "not json");
    expect(loadMigrationState(path)).toBeNull();
  });
});

// ============================================================================
// runMigration (integration)
// ============================================================================

describe("runMigration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns early when no files found", async () => {
    const provider = mockProvider();
    const logger = mockLogger();
    const result = await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );
    expect(result.total_files_processed).toBe(0);
    expect(provider.add).not.toHaveBeenCalled();
  });

  it("migrates a MEMORY.md file", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "I like TypeScript. My name is Alice.");
    const provider = mockProvider();
    const logger = mockLogger();

    const result = await runMigration(
      provider,
      { workspacePath: tmpDir, source: "memory", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );

    expect(result.total_files_processed).toBe(1);
    expect(result.total_memories_extracted).toBe(1);
    expect(provider.add).toHaveBeenCalledTimes(1);

    // Verify the messages sent to provider.add
    const call = (provider.add as any).mock.calls[0];
    const messages = call[0] as Array<{ role: string; content: string }>;
    // First message should be system preamble
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Extract durable facts");
    // Second message should be the user content
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("MEMORY.md");
    expect(messages[1].content).toContain("TypeScript");

    // Verify add options
    const opts = call[1];
    expect(opts.source).toBe("OPENCLAW_MIGRATION");
  });

  it("migrates session JSONL files", async () => {
    mkdirSync(join(tmpDir, "sessions"));
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user", content: "I work at Google" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "That's great!" } }),
    ];
    writeFileSync(join(tmpDir, "sessions", "chat.jsonl"), lines.join("\n"));

    const provider = mockProvider();
    const logger = mockLogger();

    const result = await runMigration(
      provider,
      { workspacePath: tmpDir, source: "sessions", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );

    expect(result.total_files_processed).toBe(1);
    expect(provider.add).toHaveBeenCalledTimes(1);
  });

  it("does not call provider.add in dry-run mode", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "Some facts here.");
    const provider = mockProvider();
    const logger = mockLogger();

    const result = await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: true, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );

    expect(provider.add).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("dry-run"));
  });

  it("skips already-migrated files on re-run", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "Facts about me.");
    const provider = mockProvider();
    const logger = mockLogger();

    // First run
    await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );
    expect(provider.add).toHaveBeenCalledTimes(1);

    // Second run — should skip
    (provider.add as any).mockClear();
    await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );
    expect(provider.add).not.toHaveBeenCalled();
  });

  it("re-processes files after content changes", async () => {
    const filePath = join(tmpDir, "MEMORY.md");
    writeFileSync(filePath, "Version 1.");
    const provider = mockProvider();
    const logger = mockLogger();

    // First run
    await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );
    expect(provider.add).toHaveBeenCalledTimes(1);

    // Modify file
    writeFileSync(filePath, "Version 2 with new content.");

    // Second run — should process again
    (provider.add as any).mockClear();
    const result = await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );
    expect(provider.add).toHaveBeenCalledTimes(1);
    expect(result.total_files_processed).toBeGreaterThanOrEqual(1);
  });

  it("handles provider.add errors gracefully", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "Some content.");
    const provider = mockProvider();
    (provider.add as any).mockRejectedValue(new Error("Rate limit exceeded"));
    const logger = mockLogger();

    const result = await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );

    expect(result.total_errors).toBe(1);
    expect(result.error_files).toContain("MEMORY.md");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Rate limit"));
  });

  it("respects --reset flag by ignoring previous state", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "Content.");
    const provider = mockProvider();
    const logger = mockLogger();

    // First run
    await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );
    expect(provider.add).toHaveBeenCalledTimes(1);

    // Reset run — should re-process
    (provider.add as any).mockClear();
    await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
      true, // reset
    );
    expect(provider.add).toHaveBeenCalledTimes(1);
  });

  it("filters by source type", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "Memory content.");
    mkdirSync(join(tmpDir, "sessions"));
    writeFileSync(
      join(tmpDir, "sessions", "s1.jsonl"),
      JSON.stringify({ type: "message", message: { role: "user", content: "Session content" } }),
    );
    const provider = mockProvider();
    const logger = mockLogger();

    // Only memory
    await runMigration(
      provider,
      { workspacePath: tmpDir, source: "memory", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );

    const calls = (provider.add as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].some((m: any) => m.content?.includes("MEMORY.md"))).toBe(true);
  });

  it("creates state file in workspace", async () => {
    writeFileSync(join(tmpDir, "MEMORY.md"), "Some content.");
    const provider = mockProvider();
    const logger = mockLogger();

    await runMigration(
      provider,
      { workspacePath: tmpDir, source: "all", batchSize: 2000, dryRun: false, delayMs: 0 },
      mockBuildAddOptions(),
      logger,
    );

    expect(existsSync(join(tmpDir, ".openclaw-mem0-migration.json"))).toBe(true);
  });
});
