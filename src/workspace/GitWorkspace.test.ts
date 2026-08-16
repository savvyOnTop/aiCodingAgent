import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitWorkspace } from "./GitWorkspace";
import { createLocalWorkspace } from "./LocalWorkspace";

const roots: string[] = [];

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aca-gitws-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("GitWorkspace", () => {
  it("initializes a repo, commits, and reports status/log/head", async () => {
    const inner = createLocalWorkspace({ id: "ws-git", root: await tmpRoot() });
    const git = await createGitWorkspace({ inner });

    await git.writeFile("a.txt", "one\n");
    const sha = await git.commit("first commit");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.headSha()).toBe(sha);

    const status = await git.gitStatus();
    expect(status.modified).toEqual([]);
    expect(status.untracked).toEqual([]);

    const log = await git.log();
    expect(log[0]!.sha).toBe(sha);
    expect(log[0]!.message).toBe("first commit");
  });

  it("creates and switches branches", async () => {
    const inner = createLocalWorkspace({ id: "ws-git2", root: await tmpRoot() });
    const git = await createGitWorkspace({ inner });
    await git.writeFile("a.txt", "base\n");
    await git.commit("base");
    const main = await git.currentBranch();

    await git.branch("feature");
    expect(await git.currentBranch()).toBe("feature");
    await git.writeFile("a.txt", "feature\n");
    await git.commit("feature edit");

    await git.checkout(main);
    expect(await git.currentBranch()).toBe(main);
    expect(await git.readFile("a.txt")).toBe("base\n");
  });

  it("clones from a gitUrl into the workspace", async () => {
    // source repo
    const sourceRoot = await tmpRoot();
    const source = await createGitWorkspace({
      inner: createLocalWorkspace({ id: "ws-src", root: sourceRoot })
    });
    await source.writeFile("readme.md", "cloned content\n");
    await source.commit("seed");

    // clone into a second workspace
    const inner = createLocalWorkspace({ id: "ws-clone", root: await tmpRoot() });
    const clone = await createGitWorkspace({ inner, gitUrl: sourceRoot });

    expect(await clone.readFile("readme.md")).toBe("cloned content\n");
    expect((await clone.log())[0]!.message).toBe("seed");

    // clone → edit → commit → status, all inside the root backend
    await clone.writeFile("readme.md", "edited\n");
    const midStatus = await clone.gitStatus();
    expect(midStatus.modified.length).toBeGreaterThan(0);
    await clone.commit("edit after clone");
    const endStatus = await clone.gitStatus();
    expect(endStatus.modified).toEqual([]);
  });
});
