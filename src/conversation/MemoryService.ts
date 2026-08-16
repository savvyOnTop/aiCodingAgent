import { randomUUID } from "crypto";
import type { ChatMessage } from "@ai-coding-agent/types";
import type { CompleteParams } from "../llm";
import type { MemoryRecord, MemoryRepository } from "../persistence";
import type { MessageStore } from "./MessageStore";

export interface MemoryModel {
  complete(params: CompleteParams): Promise<{ text: string | null }>;
}

export interface MemoryServiceDeps {
  store: MessageStore;
  repo: MemoryRepository;
  /** Model used for summarization; a ModelRouter satisfies this. */
  model: MemoryModel;
  /**
   * Optional semantic ranker (Phase 06 embeddings): returns a similarity
   * score added to the lexical score. Absent → pure keyword ranking.
   */
  semanticRanker?: { score(goal: string, summary: string): number };
}

export interface MemoryService {
  /** Summarizes a conversation and stores it as a memory record. */
  summarize(conversationId: string): Promise<MemoryRecord | undefined>;
  /** The most relevant stored summaries for a goal, best first. */
  recall(goal: string, limit?: number): MemoryRecord[];
  /** Drops summaries older than the retention window; returns rows removed. */
  prune(retentionDays: number): number;
}

const MAX_TRANSCRIPT_CHARS = 12_000;
const DEFAULT_RECALL_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const SUMMARY_SYSTEM =
  "Summarize this coding-agent conversation in at most 150 words. " +
  "Cover: decisions made, files touched, and open threads. Plain text only.";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "will", "should",
  "make", "using", "fix", "bug", "add", "new", "want", "please", "about", "have"
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t)
  );
}

/**
 * Durable cross-session memory (phase 08): summaries are produced by the
 * model on demand, persisted via MemoryRepository, and recalled by keyword
 * overlap (embeddings hook optional) for injection into the prompt.
 */
export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { store, repo, model, semanticRanker } = deps;

  async function summarize(conversationId: string): Promise<MemoryRecord | undefined> {
    const history = store.history(conversationId);
    if (history.length === 0) return undefined;
    const transcript = history
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(-MAX_TRANSCRIPT_CHARS);
    const messages: ChatMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: transcript }
    ];
    const result = await model.complete({ messages, tools: [], maxTokens: 400 });
    const summary = result.text?.trim();
    if (!summary) return undefined;
    const record: MemoryRecord = {
      id: randomUUID(),
      conversationId,
      summary,
      createdAt: Date.now()
    };
    repo.save(record);
    return record;
  }

  function recall(goal: string, limit = DEFAULT_RECALL_LIMIT): MemoryRecord[] {
    const goalTokens = new Set(tokenize(goal));
    if (goalTokens.size === 0) return [];
    const scored = repo.list().map((record) => {
      let score = 0;
      for (const token of tokenize(record.summary)) {
        if (goalTokens.has(token)) score++;
      }
      if (semanticRanker) score += semanticRanker.score(goal, record.summary);
      return { record, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt)
      .slice(0, limit)
      .map((s) => s.record);
  }

  function prune(retentionDays: number): number {
    return repo.prune(Date.now() - retentionDays * DAY_MS);
  }

  return { summarize, recall, prune };
}
