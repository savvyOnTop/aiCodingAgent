import cors from "@fastify/cors";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import { createConversationService, createMessageStore, type ConversationService } from "../conversation";
import { createCacheRepository, createSqliteMessageStore, SCHEMA } from "../persistence";
import { createAgentRuntime } from "../runtime";
import { createWorkspaceManager } from "../workspace";
import { authHook } from "./auth";
import { registerRoutes } from "./routes";
import { createSessionRegistry, type SessionRegistry } from "./session";
import { registerTerminal } from "./terminal";

export interface ServerOptions {
  auth?: boolean;
  authToken?: string;
  logger?: boolean;
  conversations?: ConversationService;
  sessions?: SessionRegistry;
  /** SQLite file for persistent conversations/workspaces (M5). Omit for in-memory. */
  dbPath?: string;
}

/** Gateway layer public API: a fully wired Fastify server. */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, { origin: true });

const sessions = options.sessions ?? createSessionRegistry();
  let conversations = options.conversations;
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
    conversations = createConversationService({
      runtime: createAgentRuntime({ cache }),
      store,
      workspaces
    });
  }

  if (options.auth !== false) {
    app.addHook("onRequest", async (request, reply) => {
      authHook(request, reply, { token: options.authToken });
    });
  }

  registerRoutes(app, { conversations, sessions });
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

export { createSseStream, type SseStream } from "./streaming";
export { createSessionRegistry, type SessionRegistry } from "./session";
export { registerTerminal, type TerminalOptions } from "./terminal";
export { registerRoutes, type RouteDeps } from "./routes";
export { authHook, type AuthOptions } from "./auth";
