import { randomUUID } from "crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface EmbeddingRecord {
  /** Loose content identifier (e.g. "src/foo.ts#fetchUser"). */
  contentRef: string;
  model: string;
  /** Hash of the indexed content so stale vectors are detectable. */
  contentHash: string;
  vector: number[];
  createdAt: number;
}

export interface SimilarityHit {
  contentRef: string;
  score: number;
}

export interface EmbeddingRepository {
  upsert(record: EmbeddingRecord): void;
  get(contentRef: string, model: string): EmbeddingRecord | undefined;
  /** Cosine-similarity search over stored vectors for one model. */
  similar(vector: number[], model: string, k?: number): SimilarityHit[];
  delete(contentRef: string, model: string): void;
  count(): number;
}

interface EmbeddingRow {
  id: string;
  content_ref: string;
  model: string;
  content_hash: string;
  vector: string;
  created_at: number;
}

function fromRow(row: EmbeddingRow): EmbeddingRecord {
  return {
    contentRef: row.content_ref,
    model: row.model,
    contentHash: row.content_hash,
    vector: JSON.parse(row.vector) as number[],
    createdAt: row.created_at
  };
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * SQLite-backed embedding store (phase 06). Vectors are stored as JSON text
 * (no native sqlite vector extension); similarity is computed in-process over
 * the indexed rows for a model.
 */
export function createEmbeddingRepository(db: DatabaseSync): EmbeddingRepository {
  const upsertStmt: StatementSync = db.prepare(
    `INSERT INTO embeddings (id, content_ref, model, content_hash, vector, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(content_ref, model) DO UPDATE SET
       content_hash = excluded.content_hash,
       vector = excluded.vector,
       created_at = excluded.created_at`
  );
  const getStmt: StatementSync = db.prepare(
    "SELECT * FROM embeddings WHERE content_ref = ? AND model = ?"
  );
  const listStmt: StatementSync = db.prepare("SELECT * FROM embeddings WHERE model = ?");
  const deleteStmt: StatementSync = db.prepare(
    "DELETE FROM embeddings WHERE content_ref = ? AND model = ?"
  );
  const countStmt: StatementSync = db.prepare("SELECT COUNT(*) AS n FROM embeddings");

  function upsert(record: EmbeddingRecord): void {
    upsertStmt.run(
      randomUUID(),
      record.contentRef,
      record.model,
      record.contentHash,
      JSON.stringify(record.vector),
      record.createdAt
    );
  }

  function get(contentRef: string, model: string): EmbeddingRecord | undefined {
    const row = getStmt.get(contentRef, model) as unknown as EmbeddingRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  function similar(vector: number[], model: string, k = 5): SimilarityHit[] {
    const rows = (listStmt.all(model) as unknown as EmbeddingRow[])
      .map((row) => ({ contentRef: row.content_ref, score: cosine(vector, JSON.parse(row.vector) as number[]) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    return rows.slice(0, k);
  }

  function deleteEntry(contentRef: string, model: string): void {
    deleteStmt.run(contentRef, model);
  }

  function count(): number {
    return Number((countStmt.get() as { n: number }).n);
  }

  return { upsert, get, similar, delete: deleteEntry, count };
}