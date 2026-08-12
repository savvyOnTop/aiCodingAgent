import { createHash } from "crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ChatMessage, ModelCallResult, ModelToolSchema } from "@ai-coding-agent/types";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

export interface CacheRepositoryOptions {
  /** Hard cap on stored entries; oldest is evicted when exceeded. */
  maxEntries?: number;
}

export interface CacheRepository {
  get(key: string): ModelCallResult | undefined;
  set(key: string, response: ModelCallResult, ttlMs?: number): void;
  delete(key: string): void;
  /** Removes expired entries; returns how many were pruned. */
  pruneExpired(): number;
  size(): number;
}

interface CacheRow {
  response: string;
  created_at: number;
  expires_at: number;
}

/**
 * Stable cache key: provider/model + sha256 over the full prompt (messages +
 * tool schemas), normalized by JSON serialization order.
 */
export function computeCacheKey(
  modelRef: string,
  messages: ChatMessage[],
  tools: ModelToolSchema[]
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ model: modelRef, messages, tools }))
    .digest("hex");
  return `${modelRef}-${digest.slice(0, 24)}`;
}

/**
 * SQLite-backed LLM response cache (phase 06). Consulted by ModelRouter
 * before a provider call; entries expire by TTL and are pruned lazily on
 * access plus a hard cap on table size (oldest entry evicted).
 */
export function createCacheRepository(
  db: DatabaseSync,
  options: CacheRepositoryOptions = {}
): CacheRepository {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const upsertStmt: StatementSync = db.prepare(
    `INSERT INTO llm_cache (cache_key, response, created_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       response = excluded.response,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`
  );
  const getStmt: StatementSync = db.prepare(
    "SELECT response, created_at, expires_at FROM llm_cache WHERE cache_key = ?"
  );
  const deleteStmt: StatementSync = db.prepare("DELETE FROM llm_cache WHERE cache_key = ?");
  const pruneStmt: StatementSync = db.prepare("DELETE FROM llm_cache WHERE expires_at <= ?");
  const countStmt: StatementSync = db.prepare("SELECT COUNT(*) AS n FROM llm_cache");
  const oldestStmt: StatementSync = db.prepare(
    "SELECT cache_key AS key FROM llm_cache ORDER BY created_at ASC LIMIT 1"
  );

  function pruneExpired(): number {
    return Number(pruneStmt.run(Date.now()).changes);
  }

  function get(key: string): ModelCallResult | undefined {
    pruneExpired();
    const row = getStmt.get(key) as unknown as CacheRow | undefined;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) {
      deleteStmt.run(key);
      return undefined;
    }
    return JSON.parse(row.response) as ModelCallResult;
  }

  function set(key: string, response: ModelCallResult, ttlMs: number = DEFAULT_TTL_MS): void {
    pruneExpired();
    const now = Date.now();
    upsertStmt.run(key, JSON.stringify(response), now, now + ttlMs);
    const { n } = countStmt.get() as { n: number };
    if (n > maxEntries) {
      const oldest = oldestStmt.get() as unknown as { key: string } | undefined;
      if (oldest) deleteStmt.run(oldest.key);
    }
  }

  function deleteKey(key: string): void {
    deleteStmt.run(key);
  }

  function size(): number {
    return Number((countStmt.get() as { n: number }).n);
  }

  return { get, set, delete: deleteKey, pruneExpired, size };
}