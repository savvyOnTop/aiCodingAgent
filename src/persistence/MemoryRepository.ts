import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface MemoryRecord {
  id: string;
  conversationId: string;
  summary: string;
  createdAt: number;
}

export interface MemoryRepository {
  save(record: MemoryRecord): void;
  /** All summaries, newest first. */
  list(): MemoryRecord[];
  forConversation(conversationId: string): MemoryRecord[];
  /** Deletes summaries created before `cutoff` (epoch ms); returns rows removed. */
  prune(cutoff: number): number;
}

interface RowMemory {
  id: string;
  conversation_id: string;
  summary: string;
  created_at: number;
}

function fromRow(row: RowMemory): MemoryRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    summary: row.summary,
    createdAt: row.created_at
  };
}

/**
 * Durable conversation summaries (phase 08 memory). Shares the sqlite
 * database with the other repositories (run SCHEMA first).
 */
export function createMemoryRepository(db: DatabaseSync): MemoryRepository {
  const insertStmt: StatementSync = db.prepare(
    "INSERT INTO memory (id, conversation_id, summary, created_at) VALUES (?, ?, ?, ?)"
  );
  const listStmt: StatementSync = db.prepare("SELECT * FROM memory ORDER BY created_at DESC");
  const forConversationStmt: StatementSync = db.prepare(
    "SELECT * FROM memory WHERE conversation_id = ? ORDER BY created_at DESC"
  );
  const pruneStmt: StatementSync = db.prepare("DELETE FROM memory WHERE created_at < ?");

  function save(record: MemoryRecord): void {
    insertStmt.run(record.id, record.conversationId, record.summary, record.createdAt);
  }

  function list(): MemoryRecord[] {
    return (listStmt.all() as unknown as RowMemory[]).map(fromRow);
  }

  function forConversation(conversationId: string): MemoryRecord[] {
    return (forConversationStmt.all(conversationId) as unknown as RowMemory[]).map(fromRow);
  }

  function prune(cutoff: number): number {
    return Number(pruneStmt.run(cutoff).changes);
  }

  return { save, list, forConversation, prune };
}
