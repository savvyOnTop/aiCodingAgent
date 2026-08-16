import { randomUUID } from "crypto";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationRecord, MessageRecord } from "@ai-coding-agent/types";
import { createWorkspaceManager, type WorkspaceManager } from "../workspace";
import { createBranchService, type BranchService } from "./BranchService";
import { createMessageStore, type MessageStore } from "./MessageStore";

let store: MessageStore;
let workspaces: WorkspaceManager;
let branches: BranchService;
let roots: string[];

beforeEach(() => {
  store = createMessageStore();
  workspaces = createWorkspaceManager();
  branches = createBranchService({ store, workspaces });
  roots = [];
});

afterEach(async () => {
  await workspaces.destroyAll();
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

async function makeConversation(files: Record<string, string> = {}): Promise<ConversationRecord> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aca-branch-test-"));
  roots.push(root);
  const workspace = await workspaces.create({ root });
  for (const [rel, content] of Object.entries(files)) {
    await workspace.writeFile(rel, content);
  }
  const conversation: ConversationRecord = {
    id: randomUUID(),
    workspaceId: workspace.id,
    createdAt: Date.now(),
    branchId: "main",
    parentId: null
  };
  store.create(conversation);
  return conversation;
}

function say(conversationId: string, content: string): void {
  const message: MessageRecord = {
    id: randomUUID(),
    conversationId,
    role: "user",
    content,
    toolCalls: [],
    createdAt: Date.now()
  };
  store.append(message);
}

describe("BranchService", () => {
  it("fork creates an isolated conversation and workspace", async () => {
    const parent = await makeConversation({ "src/app.ts": "export const v = 1;" });
    say(parent.id, "hello");

    const fork = await branches.fork(parent.id, "feature");

    expect(fork.parentId).toBe(parent.id);
    expect(fork.branchId).toBe("feature");
    expect(fork.workspaceId).not.toBe(parent.workspaceId);
    // history copied with fresh ids
    const forkHistory = store.history(fork.id);
    expect(forkHistory.map((m) => m.content)).toEqual(["hello"]);
    expect(forkHistory[0]!.id).not.toBe(store.history(parent.id)[0]!.id);
    // workspace copied
    const forkWs = workspaces.get(fork.workspaceId)!;
    expect(await forkWs.readFile("src/app.ts")).toBe("export const v = 1;");

    // mutations in the fork leave the parent untouched
    say(fork.id, "only in fork");
    await forkWs.writeFile("src/app.ts", "export const v = 2;");
    expect(store.history(parent.id)).toHaveLength(1);
    const parentWs = workspaces.get(parent.workspaceId)!;
    expect(await parentWs.readFile("src/app.ts")).toBe("export const v = 1;");
  });

  it("list returns the lineage tree from any member", async () => {
    const parent = await makeConversation();
    const child = await branches.fork(parent.id, "feature");
    const grandchild = await branches.fork(child.id, "feature-2");

    const treeFromLeaf = branches.list(grandchild.id);
    expect(treeFromLeaf.conversation.id).toBe(parent.id);
    expect(treeFromLeaf.children[0]!.conversation.id).toBe(child.id);
    expect(treeFromLeaf.children[0]!.children[0]!.conversation.id).toBe(grandchild.id);
  });

  it("switch marks a branch active within the lineage", async () => {
    const parent = await makeConversation();
    const fork = await branches.fork(parent.id, "feature");

    expect(branches.active(parent.id).id).toBe(parent.id);
    const switched = branches.switch(parent.id, "feature");
    expect(switched.id).toBe(fork.id);
    expect(branches.active(parent.id).id).toBe(fork.id);
    expect(() => branches.switch(parent.id, "nope")).toThrow(/not found/);
  });

  it("merge fast-forwards files changed only on the source and overlays messages", async () => {
    const parent = await makeConversation({ "a.txt": "one\ntwo\nthree\n" });
    say(parent.id, "base message");
    const fork = await branches.fork(parent.id, "feature");
    say(fork.id, "work on feature");
    const forkWs = workspaces.get(fork.workspaceId)!;
    await forkWs.writeFile("a.txt", "one\nTWO\nthree\n");
    await forkWs.writeFile("new.txt", "brand new\n");

    const result = await branches.merge("feature", "main");

    expect(result.status).toBe("clean");
    expect(result.conflicts).toEqual([]);
    expect(result.mergedFiles.sort()).toEqual(["a.txt", "new.txt"]);
    expect(result.mergedMessages).toBe(1);
    const parentWs = workspaces.get(parent.workspaceId)!;
    expect(await parentWs.readFile("a.txt")).toBe("one\nTWO\nthree\n");
    expect(await parentWs.readFile("new.txt")).toBe("brand new\n");
    expect(store.history(parent.id).map((m) => m.content)).toEqual([
      "base message",
      "work on feature"
    ]);
  });

  it("merge surfaces a conflict when both branches edit the same line", async () => {
    const parent = await makeConversation({ "a.txt": "one\ntwo\nthree\n" });
    const fork = await branches.fork(parent.id, "feature");
    await workspaces.get(fork.workspaceId)!.writeFile("a.txt", "one\nfork edit\nthree\n");
    await workspaces.get(parent.workspaceId)!.writeFile("a.txt", "one\nparent edit\nthree\n");

    const result = await branches.merge("feature", "main");

    expect(result.status).toBe("conflicts");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.path).toBe("a.txt");
    // target keeps its own version on conflict
    expect(await workspaces.get(parent.workspaceId)!.readFile("a.txt")).toBe(
      "one\nparent edit\nthree\n"
    );
  });

  it("diff reports the divergent message tails", async () => {
    const parent = await makeConversation();
    say(parent.id, "shared");
    const fork = await branches.fork(parent.id, "feature");
    say(parent.id, "main only");
    say(fork.id, "feature only");

    const diff = branches.diff("main", "feature");
    expect(diff.commonPrefix).toBe(1);
    expect(diff.onlyA.map((m) => m.content)).toEqual(["main only"]);
    expect(diff.onlyB.map((m) => m.content)).toEqual(["feature only"]);
  });
});
