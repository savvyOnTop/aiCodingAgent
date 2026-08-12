import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteMessageStore } from "./SqliteStore";
import { createConversationRepository } from "./ConversationRepository";
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

describe("ConversationRepository", () => {
  it("creates, reads, and counts conversations", () => {
    const repo = createConversationRepository(freshDb());
    repo.create({ id: "c1", workspaceId: "ws-1", createdAt: 10, branchId: "main", parentId: null });
    repo.create({ id: "c2", workspaceId: "ws-2", createdAt: 20, branchId: "feature", parentId: "c1" });

    expect(repo.get("c1")?.workspaceId).toBe("ws-1");
    expect(repo.get("c2")?.parentId).toBe("c1");
    expect(repo.count()).toBe(2);
  });

  it("lists newest-first and excludes soft-deleted by default", () => {
    const repo = createConversationRepository(freshDb());
    repo.create({ id: "old", workspaceId: "w", createdAt: 1, branchId: "main", parentId: null });
    repo.create({ id: "new", workspaceId: "w", createdAt: 2, branchId: "main", parentId: null });
    repo.softDelete("old");

    expect(repo.list().map((c) => c.id)).toEqual(["new"]);
    expect(repo.list({ includeDeleted: true }).map((c) => c.id).sort()).toEqual(["new", "old"]);
    expect(repo.list({ includeDeleted: true, offset: 1 }).map((c) => c.id)).toEqual(["old"]);
  });

  it("paginates the non-deleted list", () => {
    const repo = createConversationRepository(freshDb());
    for (let i = 1; i <= 3; i++) {
      repo.create({ id: `c${i}`, workspaceId: "w", createdAt: i, branchId: "main", parentId: null });
    }

    expect(repo.list({ limit: 1 }).map((c) => c.id)).toEqual(["c3"]);
    expect(repo.list({ limit: 1, offset: 1 }).map((c) => c.id)).toEqual(["c2"]);
    expect(repo.list({ offset: 1 }).map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("restores a soft-deleted conversation", () => {
    const repo = createConversationRepository(freshDb());
    repo.create({ id: "c1", workspaceId: "w", createdAt: 1, branchId: "main", parentId: null });
    repo.softDelete("c1");
    expect(repo.list()).toEqual([]);
    repo.restore("c1");
    expect(repo.list().map((c) => c.id)).toEqual(["c1"]);
  });

  it("hard-deletes a conversation and cascades its messages", () => {
    const dbs = freshDb();
    const repo = createConversationRepository(dbs);
    const store = createSqliteMessageStore({ db: dbs });
    repo.create({ id: "c1", workspaceId: "w", createdAt: 1, branchId: "main", parentId: null });
    store.append({
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "hello",
      toolCalls: [],
      createdAt: 2
    });

    repo.hardDelete("c1");
    expect(repo.get("c1")).toBeUndefined();
    expect(store.history("c1")).toEqual([]);
  });

  it("paginates history without mutating insertion order", () => {
    const dbs = freshDb();
    const repo = createConversationRepository(dbs);
    const store = createSqliteMessageStore({ db: dbs });
    repo.create({ id: "c1", workspaceId: "w", createdAt: 1, branchId: "main", parentId: null });
    for (let i = 0; i < 5; i++) {
      store.append({
        id: `m${i}`,
        conversationId: "c1",
        role: "user",
        content: `msg ${i}`,
        toolCalls: [],
        createdAt: i
      });
    }

    expect(repo.history("c1", { limit: 2 }).map((m) => m.content)).toEqual(["msg 0", "msg 1"]);
    expect(repo.history("c1", { limit: 2, offset: 3 }).map((m) => m.content)).toEqual([
      "msg 3",
      "msg 4"
    ]);
    expect(repo.history("c1")).toHaveLength(5);
  });

  it("shares the same tables as SqliteMessageStore", () => {
    const dbs = freshDb();
    const repo = createConversationRepository(dbs);
    const store = createSqliteMessageStore({ db: dbs });
    store.create({ id: "c1", workspaceId: "ws-shared", createdAt: 1, branchId: "main", parentId: null });

    expect(repo.get("c1")?.workspaceId).toBe("ws-shared");
    repo.softDelete("c1");
    expect(repo.list()).toEqual([]);
    repo.restore("c1");
    expect(store.history("c1")).toEqual([]);
  });
});