import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ConversationRecord, MessageRecord } from "@ai-coding-agent/types";

export interface ListConversationsOptions {
  /** Include soft-deleted conversations (default: false). */
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface HistoryOptions {
  limit?: number;
  offset?: number;
}

export interface ConversationRepository {
  create(conversation: ConversationRecord): void;
  /**
   * Returns a conversation regardless of soft-delete state; undefined when
   * the id does not exist at all.
   */
  get(id: string): ConversationRecord | undefined;
  /** Lists conversations newest-first, excluding soft-deleted by default. */
  list(options?: ListConversationsOptions): ConversationRecord[];
  /** Marks a conversation deleted without touching its messages. */
  softDelete(id: string): void;
  restore(id: string): void;
  /** Irreversibly removes the conversation row (messages cascade). */
  hardDelete(id: string): void;
  history(conversationId: string, options?: HistoryOptions): MessageRecord[];
  count(): number;
}

interface RowConversation {
  id: string;
  workspace_id: string;
  created_at: number;
  branch_id: string;
  parent_id: string | null;
  deleted_at: number | null;
}

interface RowMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string;
  created_at: number;
}

function fromConversationRow(row: RowConversation): ConversationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    branchId: row.branch_id,
    parentId: row.parent_id
  };
}

function fromMessageRow(row: RowMessage): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRecord["role"],
    content: row.content,
    toolCalls: JSON.parse(row.tool_calls),
    createdAt: row.created_at
  };
}

/**
 * Typed CRUD over conversations on top of the shared sqlite database:
 * soft-delete/restore, archival-safe listing, and paginated history.
 * Shares tables with SqliteMessageStore (run SCHEMA first).
 */
export function createConversationRepository(db: DatabaseSync): ConversationRepository {
  const insertStmt: StatementSync = db.prepare(
    "INSERT INTO conversations (id, workspace_id, created_at, branch_id, parent_id) VALUES (?, ?, ?, ?, ?)"
  );
  const getStmt: StatementSync = db.prepare("SELECT * FROM conversations WHERE id = ?");
  const listStmt: StatementSync = db.prepare("SELECT * FROM conversations ORDER BY created_at DESC");
  const softDeleteStmt: StatementSync = db.prepare(
    "UPDATE conversations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
  );
  const restoreStmt: StatementSync = db.prepare(
    "UPDATE conversations SET deleted_at = NULL WHERE id = ?"
  );
  const hardDeleteStmt: StatementSync = db.prepare("DELETE FROM conversations WHERE id = ?");
  const historyStmt: StatementSync = db.prepare(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?"
  );
  const countStmt: StatementSync = db.prepare("SELECT COUNT(*) AS n FROM conversations");

  function create(conversation: ConversationRecord): void {
    insertStmt.run(
      conversation.id,
      conversation.workspaceId,
      conversation.createdAt,
      conversation.branchId,
      conversation.parentId
    );
  }

  function get(id: string): ConversationRecord | undefined {
    const row = getStmt.get(id) as unknown as RowConversation | undefined;
    return row ? fromConversationRow(row) : undefined;
  }

  function list(options: ListConversationsOptions = {}): ConversationRecord[] {
    const rows = (listStmt.all() as unknown as RowConversation[]).filter(
      (row) => options.includeDeleted === true || row.deleted_at === null
    );
    const from = options.offset ?? 0;
    const limit = options.limit ?? rows.length;
    return rows.slice(from, from + limit).map(fromConversationRow);
  }

  function softDelete(id: string): void {
    softDeleteStmt.run(Date.now(), id);
  }

  function restore(id: string): void {
    restoreStmt.run(id);
  }

  function hardDelete(id: string): void {
    hardDeleteStmt.run(id);
  }

  function history(conversationId: string, options: HistoryOptions = {}): MessageRecord[] {
    const limit = options.limit ?? -1;
    const offset = options.offset ?? 0;
    const rows = historyStmt.all(conversationId, limit, offset) as unknown as RowMessage[];
    return rows.map(fromMessageRow);
  }

  function count(): number {
    return Number((countStmt.get() as { n: number }).n);
  }

  return { create, get, list, softDelete, restore, hardDelete, history, count };
}