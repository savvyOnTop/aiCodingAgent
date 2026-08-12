import { rm } from "fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCallResult } from "@ai-coding-agent/types";
import { createCacheRepository, computeCacheKey } from "./CacheRepository";
import { SCHEMA } from "./schema";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

afterEach(async () => {
  db?.close();
  await rm("/tmp/aca-cache-test.db", { force: true });
  await rm("/tmp/aca-cache-test.db-wal", { force: true });
  await rm("/tmp/aca-cache-test.db-shm", { force: true });
});

function result(tag: string): ModelCallResult {
  return {
    text: tag,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, model: "m", provider: "p" }
  };
}

describe("CacheRepository", () => {
  it("round-trips a response and overwrites on re-set", () => {
    const cache = createCacheRepository(db);
    cache.set("k1", result("one"));
    cache.set("k1", result("two"));

    expect(cache.get("k1")?.text).toBe("two");
    expect(cache.size()).toBe(1);
  });

  it("returns undefined for unknown keys", () => {
    const cache = createCacheRepository(db);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("expires entries after their TTL", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const cache = createCacheRepository(db);
      cache.set("k1", result("one"), 1000);
      expect(cache.get("k1")?.text).toBe("one");

      vi.setSystemTime(1_001_000);
      expect(cache.get("k1")).toBeUndefined();
      cache.set("k2", result("two"), -1000);
      expect(cache.pruneExpired()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest entry when the cap is exceeded", () => {
    const cache = createCacheRepository(db, { maxEntries: 2 });
    cache.set("a", result("a"));
    cache.set("b", result("b"));
    cache.set("c", result("c"));

    expect(cache.size()).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.text).toBe("b");
    expect(cache.get("c")?.text).toBe("c");
  });

  it("deletes a single key", () => {
    const cache = createCacheRepository(db);
    cache.set("k1", result("one"));
    cache.delete("k1");
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("persists across database reopen", () => {
    const first = new DatabaseSync("/tmp/aca-cache-test.db");
    first.exec(SCHEMA);
    createCacheRepository(first).set("survivor", result("kept"));
    first.close();

    const second = new DatabaseSync("/tmp/aca-cache-test.db");
    second.exec(SCHEMA);
    expect(createCacheRepository(second).get("survivor")?.text).toBe("kept");
    second.close();
  });
});

describe("computeCacheKey", () => {
  it("is stable for identical prompts and distinct otherwise", () => {
    const messages = [{ role: "user" as const, content: "fix the bug" }];
    const keyA = computeCacheKey("provider/model", messages, []);
    const keyB = computeCacheKey("provider/model", JSON.parse(JSON.stringify(messages)), []);
    const keyC = computeCacheKey("provider/model", [{ role: "user", content: "other" }], []);

    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(keyC);
    expect(keyA).toContain("provider/model-");
  });
});