import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { Workspace } from "@ai-coding-agent/types";
import { attachDockerWorkspace, createDockerWorkspace } from "./DockerWorkspace";
import { createLocalWorkspace } from "./LocalWorkspace";

export interface WorkspaceCreateInput {
  kind?: Workspace["kind"];
  /** Absolute directory the workspace wraps. Defaults to a scratch dir. */
  root?: string;
  /** Docker image for "docker" kind. */
  image?: string;
}

export interface WorkspaceManager {
  create(input?: WorkspaceCreateInput): Promise<Workspace>;
  get(id: string): Workspace | undefined;
  destroy(id: string): Promise<void>;
  destroyAll(): Promise<void>;
  /** Re-attach workspaces recorded by a previous process (M5). */
  rehydrate(records: WorkspaceStoreRecord[]): Promise<void>;
}

/** Minimal shape of a persisted workspace record; matches SqliteStore. */
export interface WorkspaceStoreRecord {
  id: string;
  kind: "local" | "docker" | "firecracker";
  root: string;
  containerName?: string;
  createdAt: number;
}

/**
 * Routes sessions to workspace backends; owns workspace lifecycle.
 * When a store is provided, created workspaces are recorded so a later
 * process can re-attach them via rehydrate().
 */
export function createWorkspaceManager(options: {
  store?: {
    saveWorkspace(record: WorkspaceStoreRecord): void;
    deleteWorkspaceRecord(id: string): void;
  };
} = {}): WorkspaceManager {
  const { store } = options;
  const workspaces = new Map<string, Workspace>();

  async function create(input: WorkspaceCreateInput = {}): Promise<Workspace> {
    const kind = input.kind ?? "local";
    const root = input.root ?? path.join(os.tmpdir(), "ai-coding-agent-default");
    await fs.mkdir(root, { recursive: true });
    const id = randomUUID();

    let workspace: Workspace;
    if (kind === "docker") {
      workspace = await createDockerWorkspace({ id, root, image: input.image });
    } else if (kind === "local") {
      workspace = createLocalWorkspace({ id, root });
    } else {
      throw new Error(
        `Workspace kind "${kind}" is not implemented yet (local and docker are available in M2)`
      );
    }
    workspaces.set(workspace.id, workspace);
    const withContainer = workspace as Workspace & { containerName?: string };
    store?.saveWorkspace({
      id: workspace.id,
      kind: workspace.kind as WorkspaceStoreRecord["kind"],
      root,
      containerName: withContainer.containerName,
      createdAt: Date.now()
    });
    return workspace;
  }

  function get(id: string): Workspace | undefined {
    return workspaces.get(id);
  }

  async function destroy(id: string): Promise<void> {
    const ws = workspaces.get(id);
    if (ws) {
      await ws.destroy();
      workspaces.delete(id);
      store?.deleteWorkspaceRecord(id);
    }
  }

  async function destroyAll(): Promise<void> {
    await Promise.all([...workspaces.keys()].map((id) => destroy(id)));
  }

  async function rehydrate(records: WorkspaceStoreRecord[]): Promise<void> {
    for (const record of records) {
      try {
        if (record.kind === "docker") {
          const ws = await attachDockerWorkspace({
            id: record.id,
            root: record.root,
            containerName: record.containerName
          });
          workspaces.set(ws.id, ws);
        } else if (record.kind === "local") {
          await fs.mkdir(record.root, { recursive: true });
          workspaces.set(record.id, createLocalWorkspace({ id: record.id, root: record.root }));
        }
      } catch (err) {
        // Re-attach failures are not fatal: the workspace is dropped and
        // stale records are cleaned up so future boots don't retry forever.
        store?.deleteWorkspaceRecord(record.id);
        void err;
      }
    }
  }

  return { create, get, destroy, destroyAll, rehydrate };
}
