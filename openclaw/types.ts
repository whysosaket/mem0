/**
 * Shared type definitions for the OpenClaw Mem0 plugin.
 */

export type Mem0Mode = "platform" | "open-source";

export type Mem0Config = {
  mode: Mem0Mode;
  // Platform-specific
  apiKey?: string;
  orgId?: string;
  projectId?: string;
  customInstructions: string;
  customCategories: Record<string, string>;
  enableGraph: boolean;
  // OSS-specific
  customPrompt?: string;
  oss?: {
    embedder?: { provider: string; config: Record<string, unknown> };
    vectorStore?: { provider: string; config: Record<string, unknown> };
    llm?: { provider: string; config: Record<string, unknown> };
    historyDbPath?: string;
    disableHistory?: boolean;
  };
  // Shared
  userId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  searchThreshold: number;
  topK: number;
};

export interface AddOptions {
  user_id: string;
  run_id?: string;
  custom_instructions?: string;
  custom_categories?: Array<Record<string, string>>;
  enable_graph?: boolean;
  output_format?: string;
  source?: string;
}

export interface SearchOptions {
  user_id: string;
  run_id?: string;
  top_k?: number;
  threshold?: number;
  limit?: number;
  keyword_search?: boolean;
  reranking?: boolean;
  source?: string;
}

export interface ListOptions {
  user_id: string;
  run_id?: string;
  page_size?: number;
  source?: string;
}

export interface MemoryItem {
  id: string;
  memory: string;
  user_id?: string;
  score?: number;
  categories?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface AddResultItem {
  id: string;
  memory: string;
  event: "ADD" | "UPDATE" | "DELETE" | "NOOP";
}

export interface AddResult {
  results: AddResultItem[];
}

export interface Mem0Provider {
  add(
    messages: Array<{ role: string; content: string }>,
    options: AddOptions,
  ): Promise<AddResult>;
  search(query: string, options: SearchOptions): Promise<MemoryItem[]>;
  get(memoryId: string): Promise<MemoryItem>;
  getAll(options: ListOptions): Promise<MemoryItem[]>;
  delete(memoryId: string): Promise<void>;
}

// ============================================================================
// Migration Types
// ============================================================================

export interface DiscoveredFile {
  /** Absolute path to the file */
  path: string;
  /** Path relative to workspace root */
  relativePath: string;
  /** Whether this is a memory file or session file */
  source: "memory" | "sessions";
  /** File size in bytes */
  size: number;
  /** SHA-256 content hash for change detection */
  hash: string;
}

export interface MigrationState {
  started_at: string;
  last_updated_at: string;
  /** Map of relativePath -> contentHash for successfully migrated files */
  migrated_files: Record<string, string>;
  total_files_processed: number;
  total_memories_extracted: number;
  total_errors: number;
  error_files: string[];
}

export interface MigrateOptions {
  /** Path to the OpenClaw workspace root */
  workspacePath: string;
  /** Which source types to migrate */
  source: "memory" | "sessions" | "all";
  /** Number of messages per provider.add() call */
  batchSize: number;
  /** Preview mode — no writes to Mem0 */
  dryRun: boolean;
  /** Delay in ms between provider.add() calls */
  delayMs: number;
  /** User ID override (defaults to plugin config userId) */
  userId?: string;
}
