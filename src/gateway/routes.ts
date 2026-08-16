import type { FastifyInstance } from "fastify";
import type { BranchService, ConversationService, MemoryService } from "../conversation";
import { searchWorkspace } from "../tools";
import { createSseStream } from "./streaming";
import type { SessionRegistry } from "./session";

export interface RouteDeps {
  conversations: ConversationService;
  sessions: SessionRegistry;
  /** Phase 08: branch routes are registered when provided. */
  branches?: BranchService;
  /** Phase 08: memory routes are registered when provided. */
  memory?: MemoryService;
}

export interface CreateSessionBody {
  root?: string;
  memory?: boolean;
}

export interface BranchBody {
  name?: string;
}

export interface MergeBody {
  into: string;
}

export interface SwitchBody {
  branchId: string;
}

export interface SendMessageBody {
  content: string;
}

export interface ConfirmBody {
  approved: boolean;
}

/** HTTP surface of the agent: sessions, SSE streaming, confirmations, files. */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { conversations, sessions, branches, memory } = deps;

  app.post("/api/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as CreateSessionBody;
    const conversation = await conversations.create({ root: body.root, memory: body.memory });
    return reply.code(201).send({ sessionId: conversation.id, branchId: conversation.branchId });
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

  app.get("/api/sessions/:id/search", async (request, reply) => {
    const conversationId = (request.params as { id: string }).id;
    const query = (request.query as { q?: string }).q ?? "";
    if (!query.trim()) return reply.code(400).send({ error: "q is required" });
    try {
      const workspace = conversations.getWorkspace(conversationId);
      const matches = await searchWorkspace(workspace, query, { maxResults: 50 });
      return reply.send({ matches });
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
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

  if (branches) {
    app.post("/api/sessions/:id/branch", async (request, reply) => {
      const conversationId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as BranchBody;
      try {
        const fork = await branches.fork(conversationId, body.name);
        return reply.code(201).send({ sessionId: fork.id, branchId: fork.branchId });
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.get("/api/sessions/:id/branches", async (request, reply) => {
      const conversationId = (request.params as { id: string }).id;
      try {
        const tree = branches.list(conversationId);
        const active = branches.active(conversationId);
        return reply.send({ tree, active: { sessionId: active.id, branchId: active.branchId } });
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post("/api/sessions/:id/switch", async (request, reply) => {
      const conversationId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as SwitchBody;
      if (!body.branchId) return reply.code(400).send({ error: "branchId is required" });
      try {
        const target = branches.switch(conversationId, body.branchId);
        return reply.send({ sessionId: target.id, branchId: target.branchId });
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post("/api/branches/:id/merge", async (request, reply) => {
      const sourceBranchId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as MergeBody;
      if (!body.into) return reply.code(400).send({ error: "into (target branch id) is required" });
      try {
        const result = await branches.merge(sourceBranchId, body.into);
        return reply.send(result);
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  if (memory) {
    app.post("/api/sessions/:id/summarize", async (request, reply) => {
      const conversationId = (request.params as { id: string }).id;
      const record = await memory.summarize(conversationId);
      return reply.send({ memory: record ?? null });
    });

    app.get("/api/memory/recall", async (request, reply) => {
      const goal = (request.query as { goal?: string }).goal ?? "";
      return reply.send({ memories: memory.recall(goal) });
    });
  }
}
