import { describe, expect, it } from "vitest";
import WebSocket from "ws";
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
  getWorkspace: () => ({
    id: "ws-1",
    kind: "local",
    rootPath: process.cwd(),
    readFile: async () => "",
    writeFile: async () => {},
    listDir: async () => [],
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    gitStatus: async () => ({ branch: "", modified: [], untracked: [] }),
    gitDiff: async () => "",
    destroy: async () => {}
  }),
  streamMessage: async () => {},
  confirm: () => true,
  history: () => [],
  listFiles: async () => [],
  terminate: () => {},
  destroy: async () => {}
} as unknown as ConversationService;

async function listen(app: Awaited<ReturnType<typeof buildServer>>): Promise<{ port: number; close: () => Promise<void> }> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);
  return {
    port,
    close: async () => {
      await app.close();
    }
  };
}

describe("gateway terminal", () => {
  it("rejects connections without the auth token", async () => {
    const app = await buildServer({ authToken: "secret", conversations: fakeConversations, sessions: createSessionRegistry() });
    const { port, close } = await listen(app);
    try {
      const result = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/conv-1/terminal`);
        ws.on("error", (err) => resolve(`error: ${(err as Error & { code?: string }).code ?? err.message}`));
        ws.on("close", (code) => resolve(`closed:${code}`));
        ws.on("open", () => resolve("open"));
      });
      expect(result).not.toBe("open");
    } finally {
      await close();
    }
  });

  it("spawns an interactive shell in the workspace with the token", async () => {
    const app = await buildServer({ authToken: "secret", conversations: fakeConversations, sessions: createSessionRegistry() });
    const { port, close } = await listen(app);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/api/sessions/conv-1/terminal?token=secret`
        );
        let buffer = "";
        const timer = setTimeout(() => reject(new Error("timeout")), 15_000);
        ws.on("message", (data) => {
          buffer += String(data);
          if (buffer.includes("$ ") || buffer.includes("# ")) {
            clearTimeout(timer);
            ws.send("pwd\rexit\r");
          }
          if (buffer.includes("/") && buffer.includes("exit")) {
            clearTimeout(timer);
            ws.close();
            resolve(buffer);
          }
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      expect(output).toContain("$ ");
    } finally {
      await close();
    }
  });
});
