import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { createConversationService, createMessageStore, type ConversationService } from "../conversation";
import { createAgentRuntime } from "../runtime";
import { createWorkspaceManager } from "../workspace";
import { authHook } from "./auth";
import { registerRoutes } from "./routes";
import { createSessionRegistry, type SessionRegistry } from "./session";

export interface ServerOptions {
  auth?: boolean;
  authToken?: string;
  logger?: boolean;
  conversations?: ConversationService;
  sessions?: SessionRegistry;
}

/** Gateway layer public API: a fully wired Fastify server. */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, { origin: true });

  const sessions = options.sessions ?? createSessionRegistry();
  const conversations =
    options.conversations ??
    createConversationService({
      runtime: createAgentRuntime(),
      store: createMessageStore(),
      workspaces: createWorkspaceManager()
    });

  if (options.auth !== false) {
    app.addHook("onRequest", async (request, reply) => {
      authHook(request, reply, { token: options.authToken });
    });
  }

  registerRoutes(app, { conversations, sessions });
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
