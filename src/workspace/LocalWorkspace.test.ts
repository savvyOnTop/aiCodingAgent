import { mkdtemp, realpath, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { createLocalWorkspace } from "./LocalWorkspace";

async function makeWorkspace(): Promise<{ ws: ReturnType<typeof createLocalWorkspace>; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aca-ws-"));
  const ws = createLocalWorkspace({ id: "ws-test", root });
  return { ws, root };
}

describe("LocalWorkspace", () => {
  it("round-trips read/write/list", async () => {
    const { ws, root } = await makeWorkspace();
    await ws.writeFile("src/app.ts", "export const x = 1;\n");
    expect(await ws.readFile("src/app.ts")).toBe("export const x = 1;\n");
    const entries = await ws.listDir("src");
    expect(entries).toContainEqual({ name: "app.ts", path: "src/app.ts", type: "file" });
    await rm(root, { recursive: true, force: true });
  });

  it("rejects path traversal", async () => {
    const { ws, root } = await makeWorkspace();
    await expect(ws.readFile("../secret.txt")).rejects.toThrow(/escapes/);
    await expect(ws.writeFile("../../etc/pwn", "x")).rejects.toThrow(/escapes/);
    await expect(ws.readFile("/etc/hosts")).rejects.toThrow(/escapes/);
    await rm(root, { recursive: true, force: true });
  });

  it("runs commands in the workspace root", async () => {
    const { ws, root } = await makeWorkspace();
    const res = await ws.runCommand("pwd");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(await realpath(root));
    await rm(root, { recursive: true, force: true });
  });

  it("reports non-zero exit codes", async () => {
    const { ws, root } = await makeWorkspace();
    const res = await ws.runCommand("exit 3");
    expect(res.exitCode).toBe(3);
    await rm(root, { recursive: true, force: true });
  });

  it("returns empty git status outside a repo", async () => {
    const { ws, root } = await makeWorkspace();
    const status = await ws.gitStatus();
    expect(status).toEqual({ branch: "", modified: [], untracked: [] });
    await rm(root, { recursive: true, force: true });
  });

  it("parses git status in a repo", async () => {
    const { ws, root } = await makeWorkspace();
    await ws.runCommand("git init -q && git config user.email t@t && git config user.name t");
    await writeFile(path.join(root, "a.txt"), "hi");
    await ws.runCommand("git add a.txt && git commit -qm init");
    await ws.writeFile("a.txt", "changed");
    await ws.writeFile("b.txt", "new");
    const status = await ws.gitStatus();
    expect(status.branch).toBe("main");
    expect(status.modified.length).toBe(1);
    expect(status.untracked).toContain("b.txt");
    await rm(root, { recursive: true, force: true });
  });
});
