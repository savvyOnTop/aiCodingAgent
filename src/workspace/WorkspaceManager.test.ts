import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceManager } from "./WorkspaceManager";

const saved: { id: string; kind: string; root: string; containerName?: string; createdAt: number }[] = [];
const deleted: string[] = [];
const store = {
  saveWorkspace: (r: (typeof saved)[number]) => saved.push(r),
  deleteWorkspaceRecord: (id: string) => {
    deleted.push(id);
    const i = saved.findIndex((s) => s.id === id);
    if (i >= 0) saved.splice(i, 1);
  }
};

afterEach(async () => {
  saved.length = 0;
  deleted.length = 0;
});

describe("WorkspaceManager with persistence", () => {
  it("records created workspaces and deletes the record on destroy", async () => {
    const manager = createWorkspaceManager({ store });
    const ws = await manager.create({ root: "/tmp/aca-wm-test" });

    expect(saved[0]).toMatchObject({ id: ws.id, kind: "local", root: "/tmp/aca-wm-test" });
    expect(manager.get(ws.id)?.id).toBe(ws.id);

    await manager.destroy(ws.id);
    expect(deleted).toContain(ws.id);
    expect(manager.get(ws.id)).toBeUndefined();
  });

  it("rehydrates a local workspace from a persisted record", async () => {
    const manager = createWorkspaceManager({ store });
    await manager.rehydrate([{ id: "revived", kind: "local", root: "/tmp/aca-revived", createdAt: 1 }]);

    const ws = manager.get("revived");
    expect(ws).toBeDefined();
    expect(ws!.kind).toBe("local");
    expect(ws!.rootPath).toBe("/tmp/aca-revived");
  });

  it("drops records that fail to rehydrate and cleans them up", async () => {
    const manager = createWorkspaceManager({ store });
    await manager.rehydrate([{ id: "ghost", kind: "docker", root: "/tmp", containerName: "never-exists", createdAt: 1 }]);

    expect(manager.get("ghost")).toBeUndefined();
    expect(deleted).toContain("ghost");
  });
});