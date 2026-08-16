import cors from "@fastify/cors";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createBranchService,
  createConversationService,
  createMemoryService,
  createMessageStore,
  type BranchService,
  type ConversationService,
  type MemoryService
} from "../conversation";
import { createDefaultRouter } from "../llm";
import { createCacheRepository, createMemoryRepository, createSqliteMessageStore, SCHEMA } from "../persistence";
import { createAgentRuntime } from "../runtime";
import { createWorkspaceManager } from "../workspace";
import { authHook } from "./auth";
import { sendError, toMessage } from "./errors";
import { createRateLimiter } from "./rateLimit";
import { registerRoutes } from "./routes";
import { createSessionRegistry, type SessionRegistry } from "./session";
import { registerTerminal } from "./terminal";

export interface ServerOptions {
  auth?: boolean;
  authToken?: string;
  logger?: boolean;
  conversations?: ConversationService;
  sessions?: SessionRegistry;
  branches?: BranchService;
  memory?: MemoryService;
  /** SQLite file for persistent conversations/workspaces (M5). Omit for in-memory. */
  dbPath?: string;
  /** Requests per token/IP per minute on API routes (phase 10). Pass null to disable. */
  rateLimit?: { max?: number; windowMs?: number } | null;
}

/** Gateway layer public API: a fully wired Fastify server. */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, { origin: true });

const sessions = options.sessions ?? createSessionRegistry();
  let conversations = options.conversations;
  let branches = options.branches;
  let memory = options.memory;
  if (!conversations) {
    const sqlite = options.dbPath ? createSqliteMessageStore({ dbPath: options.dbPath }) : undefined;
    const store = sqlite ?? createMessageStore();
    const workspaces = createWorkspaceManager({
      store: sqlite
        ? {
            saveWorkspace: (r) => sqlite.saveWorkspace(r),
            deleteWorkspaceRecord: (id) => sqlite.deleteWorkspaceRecord(id)
          }
        : undefined
    });
    if (sqlite) {
      await workspaces.rehydrate(sqlite.listWorkspaceRecords());
    }
    const cacheDb = new DatabaseSync(options.dbPath ?? ":memory:");
    cacheDb.exec(SCHEMA);
    const cache = createCacheRepository(cacheDb);
    const router = createDefaultRouter(process.env, cache);
    memory = memory ?? createMemoryService({
      store,
      repo: createMemoryRepository(cacheDb),
      model: router
    });
    conversations = createConversationService({
      runtime: createAgentRuntime({ router }),
      store,
      workspaces,
      memory
    });
    branches = branches ?? createBranchService({ store, workspaces });
  }

  if (options.auth !== false) {
    app.addHook("onRequest", async (request, reply) => {
      authHook(request, reply, { token: options.authToken });
    });
  }

  if (options.rateLimit !== null) {
    const limiter = createRateLimiter(options.rateLimit ?? {});
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/api/")) return;
      const key = request.headers.authorization ?? request.ip;
      if (!limiter.allow(key)) {
        return sendError(reply, "rate_limited", "too many requests");
      }
    });
  }

  app.setErrorHandler((err, _request, reply) => {
    return sendError(reply, "internal", toMessage(err));
  });

  registerRoutes(app, { conversations, sessions, branches, memory });
  registerTerminal(app, { conversations, token: options.authToken });
  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ port, host: "127.0.0.1" });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { createSseStream, type SseStream, type SseStreamOptions } from "./streaming";
export { createSessionRegistry, type SessionRegistry, type SessionRegistryOptions } from "./session";
export { registerTerminal, type TerminalOptions } from "./terminal";
export { registerRoutes, type RouteDeps } from "./routes";
export { authHook, type AuthOptions } from "./auth";
export { createRateLimiter, type RateLimiter, type RateLimiterOptions } from "./rateLimit";
export { sendError, toMessage, type GatewayError, type GatewayErrorCode } from "./errors";
