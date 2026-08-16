import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import type { ConversationRecord, MessageRecord, Workspace } from "@ai-coding-agent/types";
import { applyHunks, createConflictResolver, createUnifiedDiff, parsePatch, type ConflictResolver } from "../patch";
import type { WorkspaceManager } from "../workspace";
import type { MessageStore } from "./MessageStore";

export interface BranchServiceDeps {
  store: MessageStore;
  workspaces: WorkspaceManager;
  /** File-conflict arbitration during merge; defaults to the Phase 04 resolver. */
  resolver?: ConflictResolver;
}

export interface BranchNode {
  conversation: ConversationRecord;
  children: BranchNode[];
}

export interface MergeConflict {
  path: string;
  detail: string;
}

export interface MergeResult {
  status: "clean" | "conflicts";
  /** Messages overlaid onto the target history. */
  mergedMessages: number;
  /** Files written into the target workspace. */
  mergedFiles: string[];
  conflicts: MergeConflict[];
}

export interface BranchDiff {
  /** Number of leading messages shared by both branches (by role + content). */
  commonPrefix: number;
  onlyA: MessageRecord[];
  onlyB: MessageRecord[];
}

export interface BranchService {
  /** Forks `parentId` into a new conversation + copied workspace. */
  fork(parentId: string, branchName?: string): Promise<ConversationRecord>;
  /** Branch tree for the lineage that `conversationId` belongs to. */
  list(conversationId: string): BranchNode;
  /** Marks `branchId` the active branch of the lineage; returns its conversation. */
  switch(conversationId: string, branchId: string): ConversationRecord;
  /** The active conversation of the lineage (defaults to the queried one). */
  active(conversationId: string): ConversationRecord;
  /** Overlays source messages + files onto the target branch. */
  merge(sourceBranchId: string, targetBranchId: string): Promise<MergeResult>;
  /** Message-level diff of two branches for the UI. */
  diff(branchIdA: string, branchIdB: string): BranchDiff;
}

/** Walks a workspace recursively via its own API (works for any backend). */
async function snapshotWorkspace(workspace: Workspace, rel = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = await workspace.listDir(rel);
  for (const entry of entries) {
    if (entry.type === "dir") {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      for (const [p, c] of await snapshotWorkspace(workspace, entry.path)) files.set(p, c);
    } else {
      try {
        files.set(entry.path, await workspace.readFile(entry.path));
      } catch {
        // unreadable (binary/permission): leave out of the branch copy
      }
    }
  }
  return files;
}

/**
 * Conversation-level branching (phase 08): fork copies the message history
 * and the workspace contents into a new conversation; merge overlays messages
 * and replays file changes since the fork onto the target, arbitrating
 * conflicting edits with the Phase 04 ConflictResolver. Branch state (active
 * branch, fork-base snapshots) lives in the service, one lineage at a time.
 */
export function createBranchService(deps: BranchServiceDeps): BranchService {
  const { store, workspaces } = deps;
  const resolver = deps.resolver ?? createConflictResolver();
  /** conversationId of a fork → file contents at fork time (merge base). */
  const forkBases = new Map<string, Map<string, string>>();
  /** lineage root conversationId → active conversationId. */
  const activeByRoot = new Map<string, string>();

  function mustGet(conversationId: string): ConversationRecord {
    const conversation = store.getConversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`);
    return conversation;
  }

  function rootOf(conversationId: string): ConversationRecord {
    let current = mustGet(conversationId);
    while (current.parentId) {
      const parent = store.getConversation(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  function lineage(conversationId: string): ConversationRecord[] {
    const root = rootOf(conversationId);
    const all = store.listConversations();
    const members: ConversationRecord[] = [];
    const collect = (id: string): void => {
      const record = all.find((c) => c.id === id);
      if (record) members.push(record);
      for (const child of all.filter((c) => c.parentId === id)) collect(child.id);
    };
    collect(root.id);
    return members;
  }

  function byBranchId(branchId: string): ConversationRecord {
    const match = store.listConversations().find((c) => c.branchId === branchId);
    if (!match) throw new Error(`Unknown branch: ${branchId}`);
    return match;
  }

  async function fork(parentId: string, branchName?: string): Promise<ConversationRecord> {
    const parent = mustGet(parentId);
    const parentWorkspace = workspaces.get(parent.workspaceId);
    if (!parentWorkspace) throw new Error(`Unknown workspace: ${parent.workspaceId}`);

    const id = randomUUID();
    const workspace = await workspaces.create({
      kind: parentWorkspace.kind,
      root: path.join(os.tmpdir(), `aca-branch-${id}`)
    });
    const snapshot = await snapshotWorkspace(parentWorkspace);
    for (const [relPath, content] of snapshot) {
      await workspace.writeFile(relPath, content);
    }

    const conversation: ConversationRecord = {
      id,
      workspaceId: workspace.id,
      createdAt: Date.now(),
      branchId: branchName ?? `branch-${id.slice(0, 8)}`,
      parentId
    };
    store.create(conversation);
    const copies: MessageRecord[] = store.history(parentId).map((m) => ({
      ...m,
      id: randomUUID(),
      conversationId: id
    }));
    store.appendMany(id, copies);
    forkBases.set(id, snapshot);
    return conversation;
  }

  function list(conversationId: string): BranchNode {
    const members = lineage(conversationId);
    const build = (record: ConversationRecord): BranchNode => ({
      conversation: record,
      children: members.filter((c) => c.parentId === record.id).map(build)
    });
    return build(members[0]!);
  }

  function switchBranch(conversationId: string, branchId: string): ConversationRecord {
    const members = lineage(conversationId);
    const target = members.find((c) => c.branchId === branchId);
    if (!target) throw new Error(`Branch "${branchId}" not found in this lineage`);
    activeByRoot.set(members[0]!.id, target.id);
    return target;
  }

  function active(conversationId: string): ConversationRecord {
    const root = rootOf(conversationId);
    const activeId = activeByRoot.get(root.id);
    return activeId ? mustGet(activeId) : mustGet(conversationId);
  }

  async function merge(sourceBranchId: string, targetBranchId: string): Promise<MergeResult> {
    const source = byBranchId(sourceBranchId);
    const target = byBranchId(targetBranchId);
    const sourceWorkspace = workspaces.get(source.workspaceId);
    const targetWorkspace = workspaces.get(target.workspaceId);
    if (!sourceWorkspace) throw new Error(`Unknown workspace: ${source.workspaceId}`);
    if (!targetWorkspace) throw new Error(`Unknown workspace: ${target.workspaceId}`);

    // --- message overlay: source messages beyond the shared prefix ----------
    const sourceHistory = store.history(source.id);
    const targetHistory = store.history(target.id);
    const prefix = sharedPrefix(sourceHistory, targetHistory);
    const overlay: MessageRecord[] = sourceHistory.slice(prefix).map((m) => ({
      ...m,
      id: randomUUID(),
      conversationId: target.id
    }));
    store.appendMany(target.id, overlay);

    // --- file merge: replay source changes since the fork base --------------
    const base = forkBases.get(source.id) ?? new Map<string, string>();
    const sourceFiles = await snapshotWorkspace(sourceWorkspace);
    const targetFiles = await snapshotWorkspace(targetWorkspace);
    const mergedFiles: string[] = [];
    const conflicts: MergeConflict[] = [];

    for (const [relPath, sourceContent] of sourceFiles) {
      const targetContent = targetFiles.get(relPath);
      const baseContent = base.get(relPath);
      if (targetContent === sourceContent) continue;
      if (sourceContent === baseContent) continue; // source did not change it
      if (targetContent === undefined || targetContent === baseContent) {
        // target untouched since the fork: fast-forward to the source version
        await targetWorkspace.writeFile(relPath, sourceContent);
        mergedFiles.push(relPath);
        continue;
      }
      // both sides changed: replay the source's base→source diff on the target
      const diffText = createUnifiedDiff(baseContent ?? "", sourceContent, relPath);
      const patchFile = parsePatch(diffText)[0];
      if (!patchFile) continue;
      const attempt = applyHunks(targetContent, patchFile.hunks);
      if (attempt.ok) {
        await targetWorkspace.writeFile(relPath, attempt.content!);
        mergedFiles.push(relPath);
        continue;
      }
      const resolution = resolver.resolve(patchFile, attempt.conflict!, targetContent);
      if (resolution.status === "resolved") {
        await targetWorkspace.writeFile(relPath, resolution.content!);
        mergedFiles.push(relPath);
      } else {
        conflicts.push({ path: relPath, detail: resolution.detail });
      }
    }

    return {
      status: conflicts.length > 0 ? "conflicts" : "clean",
      mergedMessages: overlay.length,
      mergedFiles,
      conflicts
    };
  }

  function diff(branchIdA: string, branchIdB: string): BranchDiff {
    const a = store.history(byBranchId(branchIdA).id);
    const b = store.history(byBranchId(branchIdB).id);
    const prefix = sharedPrefix(a, b);
    return { commonPrefix: prefix, onlyA: a.slice(prefix), onlyB: b.slice(prefix) };
  }

  return { fork, list, switch: switchBranch, active, merge, diff };
}

function sharedPrefix(a: MessageRecord[], b: MessageRecord[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i]!.role === b[i]!.role && a[i]!.content === b[i]!.content) i++;
  return i;
}
