import { randomUUID } from "crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ToolResultStatus } from "@ai-coding-agent/types";

export interface TraceRecord {
  /** Omit to auto-generate. */
  id?: string;
  conversationId: string;
  /** Which loop iteration produced the trace (0 = initial plan). */
  step: number;
  /** Tool name, or "agent" for model-only turns. */
  tool: string;
  toolArgs: Record<string, unknown> | null;
  outcome: ToolResultStatus;
  latencyMs: number;
  createdAt: number;
}

export interface TraceListOptions {
  limit?: number;
  offset?: number;
}

export interface TraceRepository {
  append(trace: TraceRecord): void;
  listByConversation(conversationId: string): TraceRecord[];
  list(options?: TraceListOptions): TraceRecord[];
  count(): number;
}

interface TraceRow {
  id: string;
  conversation_id: string;
  step: number;
  tool: string;
  tool_args: string;
  outcome: string;
  latency_ms: number;
  created_at: number;
}

function fromRow(row: TraceRow): TraceRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    step: row.step,
    tool: row.tool,
    toolArgs: JSON.parse(row.tool_args) as Record<string, unknown> | null,
    outcome: row.outcome as ToolResultStatus,
    latencyMs: row.latency_ms,
    createdAt: row.created_at
  };
}

/**
 * Run/tool-call trace log (phase 06): one row per dispatched tool call (or
 * model-only turn), queryable per conversation or globally with pagination.
 * Feeds the observability endpoint and later failure analysis.
 */
export function createTraceRepository(db: DatabaseSync): TraceRepository {
  const insertStmt: StatementSync = db.prepare(
    `INSERT INTO traces (id, conversation_id, step, tool, tool_args, outcome, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const byConversationStmt: StatementSync = db.prepare(
    "SELECT * FROM traces WHERE conversation_id = ? ORDER BY created_at ASC, step ASC"
  );
  const listStmt: StatementSync = db.prepare(
    "SELECT * FROM traces ORDER BY created_at DESC, step DESC LIMIT ? OFFSET ?"
  );
  const countStmt: StatementSync = db.prepare("SELECT COUNT(*) AS n FROM traces");

  function append(trace: TraceRecord): void {
    insertStmt.run(
      trace.id ?? randomUUID(),
      trace.conversationId,
      trace.step,
      trace.tool,
      JSON.stringify(trace.toolArgs),
      trace.outcome,
      trace.latencyMs,
      trace.createdAt
    );
  }

  function listByConversation(conversationId: string): TraceRecord[] {
    return (byConversationStmt.all(conversationId) as unknown as TraceRow[]).map(fromRow);
  }

  function list(options: TraceListOptions = {}): TraceRecord[] {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    return (listStmt.all(limit, offset) as unknown as TraceRow[]).map(fromRow);
  }

  function count(): number {
    return Number((countStmt.get() as { n: number }).n);
  }

  return { append, listByConversation, list, count };
}