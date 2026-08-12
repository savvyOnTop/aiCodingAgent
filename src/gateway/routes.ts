import type { FastifyInstance } from "fastify";
import type { ConversationService } from "../conversation";
import { createSseStream } from "./streaming";
import type { SessionRegistry } from "./session";

export interface RouteDeps {
  conversations: ConversationService;
  sessions: SessionRegistry;
}

export interface CreateSessionBody {
  root?: string;
}

export interface SendMessageBody {
  content: string;
}

export interface ConfirmBody {
  approved: boolean;
}

/** HTTP surface of the agent: sessions, SSE streaming, confirmations, files. */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { conversations, sessions } = deps;

  app.post("/api/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as CreateSessionBody;
    const conversation = await conversations.create({ root: body.root });
    return reply.code(201).send({ sessionId: conversation.id });
  });

  app.get("/api/sessions", async (_request, reply) => {
    return reply.send({ sessions: conversations.list() });
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const conversationId = (request.params as { id: string }).id;
    sessions.close(conversationId);
    await conversations.destroy(conversationId);
    return reply.send({ ok: true });
  });

  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const body = (request.body ?? {}) as SendMessageBody;
    if (!body.content?.trim()) {
      return reply.code(400).send({ error: "content is required" });
    }
    const conversationId = (request.params as { id: string }).id;
    const stream = createSseStream(request, reply);
    sessions.attach(conversationId, stream);

    conversations
      .streamMessage(conversationId, body.content, {
        emit: (event) => stream.send(event),
        onDone: () => {
          stream.close();
          sessions.close(conversationId);
        }
      })
      .catch(async (err) => {
        stream.send({
          type: "agent.error",
          message: err instanceof Error ? err.message : String(err)
        });
        stream.close();
        sessions.close(conversationId);
      });
    return reply;
  });

  app.post("/api/sessions/:id/tools/:callId/confirm", async (request, reply) => {
    const { id: conversationId, callId } = request.params as { id: string; callId: string };
    const body = (request.body ?? {}) as ConfirmBody;
    const found = conversations.confirm(conversationId, callId, body.approved === true);
    return reply.send({ ok: found });
  });

  app.get("/api/sessions/:id/history", async (request, reply) => {
    const conversationId = (request.params as { id: string }).id;
    const history = conversations.history(conversationId);
    return reply.send({ messages: history });
  });

  app.get("/api/sessions/:id/files", async (request, reply) => {
    const conversationId = (request.params as { id: string }).id;
    const path = (request.query as { path?: string }).path ?? "";
    try {
      const entries = await conversations.listFiles(conversationId, path);
      return reply.send({ entries });
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/sessions/:id/terminate", async (request, reply) => {
    const conversationId = (request.params as { id: string }).id;
    conversations.terminate(conversationId);
    sessions.close(conversationId);
    return reply.send({ ok: true });
  });
}
