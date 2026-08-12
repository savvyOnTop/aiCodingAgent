import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ConversationRecord, MessageRecord } from "@ai-coding-agent/types";
import type { MessageStore } from "../conversation";
import { SCHEMA } from "./schema";

export interface WorkspaceStoreRecord {
  id: string;
  kind: "local" | "docker" | "firecracker";
  root: string;
  containerName?: string;
  createdAt: number;
}

export interface SqliteMessageStore extends MessageStore {
  saveWorkspace(record: WorkspaceStoreRecord): void;
  getWorkspaceRecord(id: string): WorkspaceStoreRecord | undefined;
  listWorkspaceRecords(): WorkspaceStoreRecord[];
  deleteWorkspaceRecord(id: string): void;
  close(): void;
}

export interface SqliteStoreOptions {
  /** File path; omit or use ":memory:" for a throwaway database. */
  dbPath?: string;
  /** Prebuilt database (tests); overrides dbPath. */
  db?: DatabaseSync;
}

/**
 * SQLite-backed message + conversation store (M5 persistence). Uses the
 * built-in node:sqlite (Node >= 22.5), so no native modules are needed.
 * The interface is synchronous, matching the in-memory MessageStore, so it
 * drops into ConversationService unchanged. Workspace records are persisted
 * alongside conversations so a server restart can re-attach live workspaces.
 */
export function createSqliteMessageStore(options: SqliteStoreOptions = {}): SqliteMessageStore {
  const db = options.db ?? new DatabaseSync(options.dbPath ?? ":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const insertConversation: StatementSync = db.prepare(
    "INSERT INTO conversations (id, workspace_id, created_at, branch_id, parent_id) VALUES (?, ?, ?, ?, ?)"
  );
  const getConversationStmt: StatementSync = db.prepare(
    "SELECT * FROM conversations WHERE id = ?"
  );
  const listConversationsStmt: StatementSync = db.prepare(
    "SELECT * FROM conversations ORDER BY created_at ASC"
  );
  const deleteConversationStmt: StatementSync = db.prepare(
    "DELETE FROM conversations WHERE id = ?"
  );
  const nextSeqStmt: StatementSync = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?"
  );
  const insertMessage: StatementSync = db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, tool_calls, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const historyStmt: StatementSync = db.prepare(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC"
  );
  const insertWorkspace: StatementSync = db.prepare(
    "INSERT INTO workspaces (id, kind, root, container_name, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const getWorkspaceStmt: StatementSync = db.prepare("SELECT * FROM workspaces WHERE id = ?");
  const listWorkspacesStmt: StatementSync = db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC");
  const deleteWorkspaceStmt: StatementSync = db.prepare("DELETE FROM workspaces WHERE id = ?");

  function create(conversation: ConversationRecord): void {
    insertConversation.run(
      conversation.id,
      conversation.workspaceId,
      conversation.createdAt,
      conversation.branchId,
      conversation.parentId
    );
  }

  function getConversation(id: string): ConversationRecord | undefined {
    const row = getConversationStmt.get(id) as unknown as RowConversation | undefined;
    return row ? fromConversationRow(row) : undefined;
  }

  function listConversations(): ConversationRecord[] {
    return (listConversationsStmt.all() as unknown as RowConversation[]).map(fromConversationRow);
  }

  function append(message: MessageRecord): void {
    const { next } = nextSeqStmt.get(message.conversationId) as { next: number };
    insertMessage.run(
      message.id,
      message.conversationId,
      message.role,
      message.content,
      JSON.stringify(message.toolCalls),
      message.createdAt,
      next
    );
  }

  function appendMany(conversationId: string, records: MessageRecord[]): void {
    const { next } = nextSeqStmt.get(conversationId) as { next: number };
    for (let i = 0; i < records.length; i++) {
      const message = records[i]!;
      insertMessage.run(
        message.id,
        conversationId,
        message.role,
        message.content,
        JSON.stringify(message.toolCalls),
        message.createdAt,
        next + i
      );
    }
  }

  function history(conversationId: string): MessageRecord[] {
    return (historyStmt.all(conversationId) as unknown as RowMessage[]).map(fromMessageRow);
  }

  function deleteConversation(conversationId: string): void {
    deleteConversationStmt.run(conversationId);
  }

  function saveWorkspace(record: WorkspaceStoreRecord): void {
    insertWorkspace.run(record.id, record.kind, record.root, record.containerName ?? null, record.createdAt);
  }

  function getWorkspaceRecord(id: string): WorkspaceStoreRecord | undefined {
    const row = getWorkspaceStmt.get(id) as unknown as RowWorkspace | undefined;
    return row ? fromWorkspaceRow(row) : undefined;
  }

  function listWorkspaceRecords(): WorkspaceStoreRecord[] {
    return (listWorkspacesStmt.all() as unknown as RowWorkspace[]).map(fromWorkspaceRow);
  }

  function deleteWorkspaceRecord(id: string): void {
    deleteWorkspaceStmt.run(id);
  }

  function close(): void {
    db.close();
  }

  return {
    create,
    getConversation,
    listConversations,
    append,
    appendMany,
    history,
    delete: deleteConversation,
    saveWorkspace,
    getWorkspaceRecord,
    listWorkspaceRecords,
    deleteWorkspaceRecord,
    close
  };
}

interface RowConversation {
  id: string;
  workspace_id: string;
  created_at: number;
  branch_id: string;
  parent_id: string | null;
}

interface RowMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string;
  created_at: number;
}

interface RowWorkspace {
  id: string;
  kind: string;
  root: string;
  container_name: string | null;
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

function fromWorkspaceRow(row: RowWorkspace): WorkspaceStoreRecord {
  return {
    id: row.id,
    kind: row.kind as WorkspaceStoreRecord["kind"],
    root: row.root,
    containerName: row.container_name ?? undefined,
    createdAt: row.created_at
  };
}
