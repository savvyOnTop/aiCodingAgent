import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createEmbeddingRepository } from "./EmbeddingRepository";
import { SCHEMA } from "./schema";

let db: DatabaseSync;

afterEach(() => {
  db?.close();
});

function freshDb(): DatabaseSync {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

function record(contentRef: string, vector: number[], model = "mini"): {
  contentRef: string;
  model: string;
  contentHash: string;
  vector: number[];
  createdAt: number;
} {
  return { contentRef, model, contentHash: `hash-${contentRef}`, vector, createdAt: 1 };
}

describe("EmbeddingRepository", () => {
  it("stores and retrieves an embedding", () => {
    const repo = createEmbeddingRepository(freshDb());
    repo.upsert(record("src/a.ts", [1, 0, 0]));

    const got = repo.get("src/a.ts", "mini");
    expect(got?.vector).toEqual([1, 0, 0]);
    expect(got?.contentHash).toBe("hash-src/a.ts");
    expect(repo.count()).toBe(1);
  });

  it("upserts per contentRef + model (update on conflict)", () => {
    const repo = createEmbeddingRepository(freshDb());
    repo.upsert(record("src/a.ts", [1, 0, 0]));
    repo.upsert({ ...record("src/a.ts", [0, 1, 0]), contentHash: "hash-2", createdAt: 2 });

    expect(repo.get("src/a.ts", "mini")?.vector).toEqual([0, 1, 0]);
    expect(repo.get("src/a.ts", "mini")?.contentHash).toBe("hash-2");
    expect(repo.count()).toBe(1);
  });

  it("keeps model-scoped entries separate", () => {
    const repo = createEmbeddingRepository(freshDb());
    repo.upsert(record("src/a.ts", [1, 0, 0], "mini"));
    repo.upsert(record("src/a.ts", [0, 0, 1], "large"));

    expect(repo.get("src/a.ts", "mini")?.vector).toEqual([1, 0, 0]);
    expect(repo.get("src/a.ts", "large")?.vector).toEqual([0, 0, 1]);
    expect(repo.count()).toBe(2);
  });

  it("ranks similar vectors by cosine similarity", () => {
    const repo = createEmbeddingRepository(freshDb());
    repo.upsert(record("relevant.ts", [1, 0, 0]));
    repo.upsert(record("orthogonal.ts", [0, 1, 0]));
    repo.upsert(record("half.ts", [1, 1, 0]));

    const hits = repo.similar([1, 0, 0], "mini", 2);
    expect(hits.map((h) => h.contentRef)).toEqual(["relevant.ts", "half.ts"]);
    expect(hits[0]!.score).toBeCloseTo(1);
  });

  it("excludes zero-score hits and respects k", () => {
    const repo = createEmbeddingRepository(freshDb());
    repo.upsert(record("a.ts", [1, 0]));
    repo.upsert(record("b.ts", [0, 1]));

    expect(repo.similar([1, 0], "mini", 5).map((h) => h.contentRef)).toEqual(["a.ts"]);
    expect(repo.similar([2, 0], "mini", 10)).toHaveLength(1);
    expect(repo.similar([0, 0], "mini", 10)).toEqual([]);
  });

  it("deletes an entry", () => {
    const repo = createEmbeddingRepository(freshDb());
    repo.upsert(record("a.ts", [1, 0]));
    repo.upsert(record("b.ts", [0, 1]));

    repo.delete("a.ts", "mini");
    expect(repo.get("a.ts", "mini")).toBeUndefined();
    expect(repo.count()).toBe(1);
  });
});