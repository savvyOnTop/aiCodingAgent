import { describe, expect, it } from "vitest";
import type { ConversationRecord } from "@ai-coding-agent/types";
import type { BranchService, ConversationService, MemoryService } from "../conversation";
import { buildServer } from "./index";
import { createSessionRegistry } from "./session";

const fakeConversations = {
  create: async (): Promise<ConversationRecord> => ({
    id: "conv-1",
    workspaceId: "ws-1",
    createdAt: 0,
    branchId: "main",
    parentId: null
  }),
  streamMessage: async (
    _id: string,
    _content: string,
    callbacks: { emit: (e: never) => void; onDone?: () => void }
  ) => {
    callbacks.emit({ type: "agent.done", summary: "ok", usage: null } as never);
    callbacks.onDone?.();
  },
  confirm: () => true,
  list: () => [
    {
      id: "conv-1",
      workspaceId: "ws-1",
      createdAt: 0,
      branchId: "main",
      parentId: null
    }
  ],
  history: () => [],
  listFiles: async () => [{ name: "a.ts", path: "a.ts", type: "file" }],
  terminate: () => {},
  destroy: async () => {}
} as unknown as ConversationService;

describe("gateway routes", () => {
  it("rejects unauthenticated requests", async () => {
    const app = await buildServer({ authToken: "secret", conversations: fakeConversations, sessions: createSessionRegistry() });
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("creates a session", async () => {
    const app = await buildServer({ authToken: "secret", conversations: fakeConversations, sessions: createSessionRegistry() });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: "Bearer secret" },
      payload: {}
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sessionId).toBe("conv-1");
    await app.close();
  });

  it("streams agent events over the message endpoint", async () => {
    const app = await buildServer({ authToken: "secret", conversations: fakeConversations, sessions: createSessionRegistry() });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/conv-1/messages",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: JSON.stringify({ content: "hi" })
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.payload).toContain("agent.done");
    await app.close();
  });

  it("lists workspace files", async () => {
    const app = await buildServer({ authToken: "secret", conversations: fakeConversations, sessions: createSessionRegistry() });
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/conv-1/files",
      headers: { authorization: "Bearer secret" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0].path).toBe("a.ts");
    await app.close();
  });

  it("lists sessions", async () => {
    const app = await buildServer({ authToken: "secret", conversations: fakeConversations, sessions: createSessionRegistry() });
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { authorization: "Bearer secret" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions[0].id).toBe("conv-1");
    await app.close();
  });

  it("deletes a session", async () => {
    const app = await buildServer({ authToken: "secret", conversations: fakeConversations, sessions: createSessionRegistry() });
    const res = await app.inject({
      method: "DELETE",
      url: "/api/sessions/conv-1",
      headers: { authorization: "Bearer secret" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it("forks and lists branches when a branch service is wired", async () => {
    const forked: ConversationRecord = {
      id: "conv-2",
      workspaceId: "ws-2",
      createdAt: 1,
      branchId: "feature",
      parentId: "conv-1"
    };
    const fakeBranches = {
      fork: async () => forked,
      list: () => ({
        conversation: { id: "conv-1", workspaceId: "ws-1", createdAt: 0, branchId: "main", parentId: null },
        children: [{ conversation: forked, children: [] }]
      }),
      active: () => forked,
      switch: () => forked,
      merge: async () => ({ status: "clean", mergedMessages: 0, mergedFiles: [], conflicts: [] }),
      diff: () => ({ commonPrefix: 0, onlyA: [], onlyB: [] })
    } as unknown as BranchService;
    const app = await buildServer({
      authToken: "secret",
      conversations: fakeConversations,
      sessions: createSessionRegistry(),
      branches: fakeBranches
    });

    const fork = await app.inject({
      method: "POST",
      url: "/api/sessions/conv-1/branch",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: JSON.stringify({ name: "feature" })
    });
    expect(fork.statusCode).toBe(201);
    expect(fork.json()).toEqual({ sessionId: "conv-2", branchId: "feature" });

    const list = await app.inject({
      method: "GET",
      url: "/api/sessions/conv-1/branches",
      headers: { authorization: "Bearer secret" }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().tree.children[0].conversation.branchId).toBe("feature");
    expect(list.json().active.branchId).toBe("feature");

    const merge = await app.inject({
      method: "POST",
      url: "/api/branches/feature/merge",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: JSON.stringify({ into: "main" })
    });
    expect(merge.statusCode).toBe(200);
    expect(merge.json().status).toBe("clean");
    await app.close();
  });

  it("summarizes a session when a memory service is wired", async () => {
    const fakeMemory = {
      summarize: async (conversationId: string) => ({
        id: "m1",
        conversationId,
        summary: "did things",
        createdAt: 0
      }),
      recall: () => [],
      prune: () => 0
    } as unknown as MemoryService;
    const app = await buildServer({
      authToken: "secret",
      conversations: fakeConversations,
      sessions: createSessionRegistry(),
      memory: fakeMemory
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/conv-1/summarize",
      headers: { authorization: "Bearer secret" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().memory.summary).toBe("did things");
    await app.close();
  });
});
