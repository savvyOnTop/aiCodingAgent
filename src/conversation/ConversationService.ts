import { randomUUID } from "crypto";
import type {
  ChatMessage,
  ConversationRecord,
  FileEntry,
  MessageRecord,
  SseEvent,
  ToolCall,
  Workspace
} from "@ai-coding-agent/types";
import type { AgentRuntime, RunResult } from "../runtime";
import type { WorkspaceManager } from "../workspace";
import type { MemoryService } from "./MemoryService";
import type { MessageStore } from "./MessageStore";

export interface CreateConversationInput {
  root?: string;
  workspaceKind?: Workspace["kind"];
  /** Opt this conversation into cross-session memory (summarized after runs). */
  memory?: boolean;
}

export interface StreamCallbacks {
  emit(event: SseEvent): void;
  onDone?(run: RunResult): void;
}

export interface ConversationServiceDeps {
  runtime: AgentRuntime;
  store: MessageStore;
  workspaces: WorkspaceManager;
  /** Phase 08 memory: recall before each run, summarize opted-in runs after. */
  memory?: MemoryService;
}

export interface ConversationService {
  create(input?: CreateConversationInput): Promise<ConversationRecord>;
  list(): ConversationRecord[];
  streamMessage(conversationId: string, content: string, callbacks: StreamCallbacks): Promise<void>;
  confirm(conversationId: string, callId: string, approved: boolean): boolean;
  terminate(conversationId: string): void;
  history(conversationId: string): MessageRecord[];
  listFiles(conversationId: string, path?: string): Promise<FileEntry[]>;
  getWorkspace(conversationId: string): Workspace;
  destroy(conversationId: string): Promise<void>;
}

const CONFIRM_TIMEOUT_MS = 5 * 60_000;

interface PendingConfirmation {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SECRET_KEY_HINT = /(KEY|TOKEN|SECRET|PASSWORD|AUTH)/;

/**
 * Conversation layer: owns the message store, creates sessions with their
 * workspaces, streams agent runs, and brokers tool confirmations.
 */
export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  const { runtime, store, workspaces, memory } = deps;
  const pending = new Map<string, PendingConfirmation>();
  const controllers = new Map<string, AbortController>();
  /** Conversations opted into memory (summarized after each run). */
  const memoryEnabled = new Set<string>();

  async function create(input: CreateConversationInput = {}): Promise<ConversationRecord> {
    const workspace = await workspaces.create({
      kind: input.workspaceKind,
      root: input.root
    });
    const conversation: ConversationRecord = {
      id: randomUUID(),
      workspaceId: workspace.id,
      createdAt: Date.now(),
      branchId: "main",
      parentId: null
    };
    store.create(conversation);
    if (input.memory === true) memoryEnabled.add(conversation.id);
    return conversation;
  }

  async function streamMessage(
    conversationId: string,
    content: string,
    callbacks: StreamCallbacks
  ): Promise<void> {
    const conversation = store.getConversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`);
    const workspace = workspaces.get(conversation.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${conversation.workspaceId}`);

    store.append({
      id: randomUUID(),
      conversationId,
      role: "user",
      content,
      toolCalls: [],
      createdAt: Date.now()
    });

    const history = toChatMessages(store.history(conversationId));
    const controller = new AbortController();
    controllers.set(conversationId, controller);

    const redact = (text: string): string => {
      let out = text;
      for (const [key, value] of Object.entries(process.env)) {
        if (value && SECRET_KEY_HINT.test(key)) out = out.split(value).join("***");
      }
      return out;
    };

    const recalled = memory ? memory.recall(content).map((r) => r.summary) : undefined;
    const run = await runtime.run(
      {
        task: content,
        history,
        workspace,
        sessionId: conversationId,
        cwd: ".",
        redact,
        memory: recalled
      },
      {
        emit: callbacks.emit,
        requestConfirmation: (call: ToolCall) =>
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), CONFIRM_TIMEOUT_MS);
            pending.set(call.id, { resolve, timer });
          })
      },
      controller.signal
    );

    controllers.delete(conversationId);
    persistTranscript(conversationId, run.transcript.slice(1));
    callbacks.emit({ type: "agent.done", summary: run.summary, usage: run.usage });
    if (memory && memoryEnabled.has(conversationId)) {
      // Memory is opt-in; a summarization failure must not fail the run.
      await memory.summarize(conversationId).catch(() => undefined);
    }
    callbacks.onDone?.(run);
  }

  function list(): ConversationRecord[] {
    return store.listConversations();
  }

  function confirm(conversationId: string, callId: string, approved: boolean): boolean {
    const entry = pending.get(callId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(callId);
    entry.resolve(approved);
    return true;
  }

  function terminate(conversationId: string): void {
    controllers.get(conversationId)?.abort();
    controllers.delete(conversationId);
    for (const [callId, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve(false);
      pending.delete(callId);
    }
  }

  function history(conversationId: string): MessageRecord[] {
    return store.history(conversationId);
  }

  async function listFiles(conversationId: string, path = ""): Promise<FileEntry[]> {
    const workspace = getWorkspace(conversationId);
    return workspace.listDir(path);
  }

  function getWorkspace(conversationId: string): Workspace {
    const conversation = store.getConversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`);
    const workspace = workspaces.get(conversation.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${conversation.workspaceId}`);
    return workspace;
  }

  async function destroy(conversationId: string): Promise<void> {
    terminate(conversationId);
    const conversation = store.getConversation(conversationId);
    if (conversation) await workspaces.destroy(conversation.workspaceId);
    store.delete(conversationId);
  }

  function persistTranscript(conversationId: string, transcript: ChatMessage[]): void {
    const records: MessageRecord[] = transcript.map((m) => ({
      id: randomUUID(),
      conversationId,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ?? [],
      createdAt: Date.now()
    }));
    store.appendMany(conversationId, records);
  }

  function toChatMessages(records: MessageRecord[]): ChatMessage[] {
    return records.map((r) => ({
      role: r.role,
      content: r.content,
      toolCalls: r.toolCalls.length ? r.toolCalls : undefined
    }));
  }

  return { create, list, streamMessage, confirm, terminate, history, listFiles, getWorkspace, destroy };
}
