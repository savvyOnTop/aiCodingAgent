import { rm } from "fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationRecord, MessageRecord } from "@ai-coding-agent/types";
import { createSqliteMessageStore } from "./SqliteStore";

const dbPath = "/tmp/aca-sqlite-test.db";

function conversation(id: string): ConversationRecord {
  return { id, workspaceId: `ws-${id}`, createdAt: 1, branchId: "main", parentId: null };
}

function message(conversationId: string, role: MessageRecord["role"], content: string): MessageRecord {
  return { id: `${conversationId}-${role}`, conversationId, role, content, toolCalls: [], createdAt: 2 };
}

afterEach(async () => {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
});

describe("SqliteMessageStore", () => {
  it("creates and reads conversations and messages", () => {
    const store = createSqliteMessageStore();
    store.create(conversation("c1"));
    store.append(message("c1", "user", "hello"));
    store.append(message("c1", "assistant", "hi there"));

    expect(store.getConversation("c1")?.workspaceId).toBe("ws-c1");
    expect(store.history("c1").map((m) => m.content)).toEqual(["hello", "hi there"]);
    store.close();
  });

  it("preserves message order and toolCalls round-trip", () => {
    const store = createSqliteMessageStore();
    store.create(conversation("c1"));
    store.appendMany("c1", [
      { ...message("c1", "assistant", "first"), id: "m1" },
      { ...message("c1", "assistant", "second"), id: "m2", toolCalls: [{ id: "t1", name: "write_file", input: {} }] }
    ]);
    const history = store.history("c1");
    expect(history[0]!.content).toBe("first");
    expect(history[1]!.toolCalls[0]!.name).toBe("write_file");
    store.close();
  });

  it("lists and deletes conversations", () => {
    const store = createSqliteMessageStore();
    store.create(conversation("c1"));
    store.create(conversation("c2"));
    expect(store.listConversations().map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    store.delete("c1");
    expect(store.listConversations().map((c) => c.id)).toEqual(["c2"]);
    store.close();
  });

  it("deleting a conversation cascades to its messages", () => {
    const store = createSqliteMessageStore();
    store.create(conversation("c1"));
    store.append(message("c1", "user", "hello"));
    store.delete("c1");
    expect(store.history("c1")).toEqual([]);
    store.close();
  });

  it("persists conversations across store reopen (same db file)", () => {
    const first = createSqliteMessageStore({ dbPath });
    first.create(conversation("c1"));
    first.append(message("c1", "user", "survives restart"));
    first.saveWorkspace({ id: "ws-c1", kind: "local", root: "/tmp/aca-ws", createdAt: 1 });
    first.close();

    const second = createSqliteMessageStore({ dbPath });
    expect(second.getConversation("c1")).toBeDefined();
    expect(second.history("c1")[0]!.content).toBe("survives restart");
    expect(second.listWorkspaceRecords()[0]!.root).toBe("/tmp/aca-ws");
    second.close();
  });

  it("workspace records can be saved, listed, and deleted", () => {
    const store = createSqliteMessageStore();
    store.saveWorkspace({ id: "w1", kind: "docker", root: "/r", containerName: "aca-w1", createdAt: 1 });
    store.saveWorkspace({ id: "w2", kind: "local", root: "/r2", createdAt: 2 });
    expect(store.getWorkspaceRecord("w1")?.containerName).toBe("aca-w1");
    expect(store.listWorkspaceRecords().length).toBe(2);
    store.deleteWorkspaceRecord("w1");
    expect(store.getWorkspaceRecord("w1")).toBeUndefined();
    store.close();
  });

  it("requires a created conversation before appending", () => {
    const store = createSqliteMessageStore();
    expect(() => store.append(message("nope", "user", "x"))).toThrow();
    store.close();
  });
});
