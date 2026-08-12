import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ModelCallResult } from "@ai-coding-agent/types";
import { createCacheRepository, SCHEMA } from "../persistence";
import { createModelRouter } from "./ModelRouter";
import { LlmError, type ModelAdapter } from "./types";

function result(provider: string): ModelCallResult {
  return {
    text: `${provider}-response`,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, model: provider, provider }
  };
}

function fakeAdapter(provider: string, behavior: () => Promise<ModelCallResult>): ModelAdapter {
  return {
    provider,
    model: provider,
    isConfigured: () => true,
    complete: behavior
  };
}

describe("ModelRouter", () => {
  it("uses the first configured adapter", async () => {
    const a = fakeAdapter("a", vi.fn(async () => result("a")));
    const router = createModelRouter({ adapters: [a] });
    const res = await router.complete({ messages: [], tools: [] });
    expect(res.text).toBe("a-response");
    expect(a.complete).toHaveBeenCalledOnce();
  });

  it("fails over to the next adapter when the first throws", async () => {
    const a = fakeAdapter("a", async () => {
      throw new LlmError("boom", "a", true);
    });
    const b = fakeAdapter("b", vi.fn(async () => result("b")));
    const router = createModelRouter({ adapters: [a, b] });
    const res = await router.complete({ messages: [], tools: [] });
    expect(res.text).toBe("b-response");
  });

  it("skips unconfigured adapters", async () => {
    const a: ModelAdapter = { provider: "a", model: "a", isConfigured: () => false, complete: vi.fn() };
    const b = fakeAdapter("b", vi.fn(async () => result("b")));
    const router = createModelRouter({ adapters: [a, b] });
    const res = await router.complete({ messages: [], tools: [] });
    expect(res.text).toBe("b-response");
  });

  it("throws when nothing is configured", async () => {
    const a: ModelAdapter = { provider: "a", model: "a", isConfigured: () => false, complete: vi.fn() };
    const router = createModelRouter({ adapters: [a] });
    await expect(router.complete({ messages: [], tools: [] })).rejects.toThrow(/No LLM provider/);
  });

  it("serves cached responses without calling the adapter again", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    const cache = createCacheRepository(db);
    const adapter = fakeAdapter("a", vi.fn(async () => result("a")));
    const router = createModelRouter({ adapters: [adapter], cache });
    const params = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

    const first = await router.complete(params);
    expect(first.text).toBe("a-response");
    expect(adapter.complete).toHaveBeenCalledOnce();

    const second = await router.complete(params);
    expect(second).toEqual(first);
    expect(adapter.complete).toHaveBeenCalledOnce();
    db.close();
  });

  it("caches independently per provider when failover occurs", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    const cache = createCacheRepository(db);
    const a = fakeAdapter("a", async () => {
      throw new LlmError("down", "a", true);
    });
    const b = fakeAdapter("b", vi.fn(async () => result("b")));
    const router = createModelRouter({ adapters: [a, b], cache });
    const params = { messages: [{ role: "user" as const, content: "ping" }], tools: [] };

    const first = await router.complete(params);
    expect(first.text).toBe("b-response");
    expect(b.complete).toHaveBeenCalledOnce();

    const second = await router.complete(params);
    expect(second.text).toBe("b-response");
    expect(b.complete).toHaveBeenCalledOnce();
    db.close();
  });
});
