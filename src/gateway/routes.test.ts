import { describe, expect, it } from "vitest";
import type { ConversationRecord } from "@ai-coding-agent/types";
import type { ConversationService } from "../conversation";
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
});
