import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryRepository, SCHEMA, type MemoryRepository } from "../persistence";
import { createMemoryService, type MemoryService } from "./MemoryService";
import { createMessageStore, type MessageStore } from "./MessageStore";

let store: MessageStore;
let repo: MemoryRepository;
let service: MemoryService;
let completions: string[];

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  store = createMessageStore();
  repo = createMemoryRepository(db);
  completions = [];
  service = createMemoryService({
    store,
    repo,
    model: {
      complete: async (params) => {
        completions.push(params.messages.at(-1)!.content);
        return { text: "Refactored the docker workspace; touched DockerWorkspace.ts; tests pending." };
      }
    }
  });
});

function seedConversation(content: string): string {
  const conversationId = randomUUID();
  store.create({
    id: conversationId,
    workspaceId: "ws-1",
    createdAt: Date.now(),
    branchId: "main",
    parentId: null
  });
  store.append({
    id: randomUUID(),
    conversationId,
    role: "user",
    content,
    toolCalls: [],
    createdAt: Date.now()
  });
  return conversationId;
}

describe("MemoryService", () => {
  it("summarize stores a memory record for the conversation", async () => {
    const conversationId = seedConversation("please refactor the docker workspace");

    const record = await service.summarize(conversationId);

    expect(record).toBeDefined();
    expect(record!.conversationId).toBe(conversationId);
    expect(repo.list()).toHaveLength(1);
    expect(repo.forConversation(conversationId)[0]!.summary).toContain("docker");
    // the transcript was actually sent to the model
    expect(completions[0]).toContain("refactor the docker workspace");
  });

  it("summarize of an empty conversation stores nothing", async () => {
    const conversationId = randomUUID();
    store.create({
      id: conversationId,
      workspaceId: "ws-1",
      createdAt: Date.now(),
      branchId: "main",
      parentId: null
    });
    expect(await service.summarize(conversationId)).toBeUndefined();
    expect(repo.list()).toHaveLength(0);
  });

  it("recall returns the relevant summary for a matching goal", () => {
    repo.save({
      id: "m1",
      conversationId: "c1",
      summary: "Implemented docker workspace attach and container reuse.",
      createdAt: Date.now()
    });
    repo.save({
      id: "m2",
      conversationId: "c2",
      summary: "Styled the chat panel scrollbars.",
      createdAt: Date.now()
    });

    const hits = service.recall("fix docker container startup");
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
    expect(service.recall("")).toEqual([]);
  });

  it("prune removes summaries older than the retention window", () => {
    const now = Date.now();
    repo.save({ id: "old", conversationId: "c1", summary: "ancient work", createdAt: now - 40 * 24 * 60 * 60 * 1000 });
    repo.save({ id: "fresh", conversationId: "c2", summary: "recent work", createdAt: now });

    const removed = service.prune(30);

    expect(removed).toBe(1);
    expect(repo.list().map((r) => r.id)).toEqual(["fresh"]);
  });
});
