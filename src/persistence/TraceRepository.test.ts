import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTraceRepository, type TraceRecord } from "./TraceRepository";
import { SCHEMA } from "./schema";

let db: DatabaseSync;

afterEach(() => {
  db?.close();
});

function freshDb(): DatabaseSync {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

function trace(conversationId: string, step: number, tool: string, createdAt: number): TraceRecord {
  return {
    conversationId,
    step,
    tool,
    toolArgs: { file: "a.ts" },
    outcome: "success",
    latencyMs: 12,
    createdAt
  };
}

describe("TraceRepository", () => {
  it("appends traces and auto-generates ids", () => {
    const repo = createTraceRepository(freshDb());
    repo.append(trace("c1", 0, "agent", 1));
    repo.append(trace("c1", 1, "search", 2));

    const all = repo.list();
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBeDefined();
    expect(all[0]!.conversationId).toBe("c1");
    expect(repo.count()).toBe(2);
  });

  it("round-trips tool args and outcome", () => {
    const repo = createTraceRepository(freshDb());
    repo.append({
      conversationId: "c1",
      step: 2,
      tool: "write_file",
      toolArgs: { path: "src/x.ts", content: "let a = 1" },
      outcome: "needs_confirmation",
      latencyMs: 40,
      createdAt: 1
    });
    repo.append({ ...trace("c1", 3, "run", 2), toolArgs: null, outcome: "error" });

    const list = repo.list();
    // list() is newest-first: the null-args trace (createdAt 2) comes first.
    expect(list[0]!.toolArgs).toBeNull();
    expect(list[0]!.outcome).toBe("error");
    expect(list[1]!.toolArgs).toEqual({ path: "src/x.ts", content: "let a = 1" });
    expect(list[1]!.outcome).toBe("needs_confirmation");
  });

  it("lists per conversation in chronological order", () => {
    const repo = createTraceRepository(freshDb());
    repo.append(trace("c1", 0, "agent", 10));
    repo.append(trace("c1", 1, "search", 20));
    repo.append(trace("c2", 0, "agent", 30));

    expect(repo.listByConversation("c1").map((t) => t.tool)).toEqual(["agent", "search"]);
    expect(repo.listByConversation("c2")).toHaveLength(1);
  });

  it("paginates the global list newest-first", () => {
    const repo = createTraceRepository(freshDb());
    for (let i = 1; i <= 5; i++) repo.append(trace("c1", i, "run", i));

    expect(repo.list({ limit: 2 }).map((t) => t.createdAt)).toEqual([5, 4]);
    expect(repo.list({ limit: 2, offset: 2 }).map((t) => t.createdAt)).toEqual([3, 2]);
  });
});