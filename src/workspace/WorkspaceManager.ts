import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { Workspace } from "@ai-coding-agent/types";
import { createLocalWorkspace } from "./LocalWorkspace";

export interface WorkspaceCreateInput {
  kind?: Workspace["kind"];
  /** Absolute directory the workspace wraps. Defaults to a scratch dir. */
  root?: string;
}

export interface WorkspaceManager {
  create(input?: WorkspaceCreateInput): Promise<Workspace>;
  get(id: string): Workspace | undefined;
  destroy(id: string): Promise<void>;
  destroyAll(): Promise<void>;
}

/** Routes sessions to workspace backends; owns workspace lifecycle. */
export function createWorkspaceManager(): WorkspaceManager {
  const workspaces = new Map<string, Workspace>();

  async function create(input: WorkspaceCreateInput = {}): Promise<Workspace> {
    const kind = input.kind ?? "local";
    if (kind !== "local") {
      throw new Error(
        `Workspace kind "${kind}" is not implemented yet (local is the only backend in M1)`
      );
    }
    const root = input.root ?? path.join(os.tmpdir(), "ai-coding-agent-default");
    await fs.mkdir(root, { recursive: true });
    const workspace = createLocalWorkspace({ id: randomUUID(), root });
    workspaces.set(workspace.id, workspace);
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
    }
  }

  async function destroyAll(): Promise<void> {
    await Promise.all([...workspaces.keys()].map((id) => destroy(id)));
  }

  return { create, get, destroy, destroyAll };
}
