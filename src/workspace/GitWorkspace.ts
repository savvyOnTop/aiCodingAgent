import type { CommandResult, Workspace } from "@ai-coding-agent/types";

export interface GitWorkspaceOptions {
  /** Root backend the git repo lives in (local/docker/firecracker). */
  inner: Workspace;
  /** Clone this URL into the workspace when it is not already a repo. */
  gitUrl?: string;
  /** Identity used for commits when the repo has none configured. */
  authorName?: string;
  authorEmail?: string;
}

export interface GitLogEntry {
  sha: string;
  message: string;
}

export interface GitWorkspace extends Workspace {
  /** Stage everything and commit; returns the new HEAD sha. */
  commit(message: string): Promise<string>;
  log(limit?: number): Promise<GitLogEntry[]>;
  /** Create a branch and switch to it. */
  branch(name: string): Promise<void>;
  checkout(ref: string): Promise<void>;
  currentBranch(): Promise<string>;
  headSha(): Promise<string>;
}

/**
 * Git-native workspace (phase 10): composes a root backend instead of adding
 * a fourth kind. Materializes a repo on creation (clone from gitUrl, `git init`
 * otherwise), guarantees a commit identity, and exposes the git primitives
 * GitTool builds on. branch/headSha are queryable for workspace records.
 */
export async function createGitWorkspace(options: GitWorkspaceOptions): Promise<GitWorkspace> {
  const inner = options.inner;
  const authorName = options.authorName ?? "ai-coding-agent";
  const authorEmail = options.authorEmail ?? "agent@local";

  async function git(args: string): Promise<CommandResult> {
    return inner.runCommand(`git ${args}`);
  }

  async function gitOrThrow(args: string, what: string): Promise<string> {
    const res = await git(args);
    if (res.exitCode !== 0) {
      throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res.stdout.trim();
  }

  // --- materialize ----------------------------------------------------------
  const probe = await git("rev-parse --is-inside-work-tree 2>/dev/null");
  const isRepo = probe.exitCode === 0 && probe.stdout.trim() === "true";
  if (!isRepo) {
    if (options.gitUrl) {
      await gitOrThrow(`clone ${JSON.stringify(options.gitUrl)} .`, "git clone");
    } else {
      await gitOrThrow("init", "git init");
    }
  }
  // commit identity: local config only, never touching the user's global one
  const email = await git("config user.email");
  if (email.exitCode !== 0 || !email.stdout.trim()) {
    await gitOrThrow(`config user.email ${JSON.stringify(authorEmail)}`, "git config");
    await gitOrThrow(`config user.name ${JSON.stringify(authorName)}`, "git config");
  }

  async function commit(message: string): Promise<string> {
    await gitOrThrow("add -A", "git add");
    await gitOrThrow(`commit -m ${JSON.stringify(message)}`, "git commit");
    return headSha();
  }

  async function log(limit = 20): Promise<GitLogEntry[]> {
    const res = await git(`log --format=%H%x09%s -n ${Math.max(1, limit)}`);
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        const [sha, ...rest] = row.split("\t");
        return { sha: sha ?? "", message: rest.join("\t") };
      });
  }

  async function branch(name: string): Promise<void> {
    await gitOrThrow(`checkout -b ${JSON.stringify(name)}`, "git branch");
  }

  async function checkout(ref: string): Promise<void> {
    await gitOrThrow(`checkout ${JSON.stringify(ref)}`, "git checkout");
  }

  async function currentBranch(): Promise<string> {
    return gitOrThrow("rev-parse --abbrev-ref HEAD", "git rev-parse");
  }

  async function headSha(): Promise<string> {
    return gitOrThrow("rev-parse HEAD", "git rev-parse");
  }

  return {
    id: inner.id,
    kind: inner.kind,
    rootPath: inner.rootPath,
    readFile: (p) => inner.readFile(p),
    writeFile: (p, c) => inner.writeFile(p, c),
    listDir: (p) => inner.listDir(p),
    runCommand: (cmd, cwd) => inner.runCommand(cmd, cwd),
    gitStatus: () => inner.gitStatus(),
    gitDiff: (p) => inner.gitDiff(p),
    destroy: () => inner.destroy(),
    commit,
    log,
    branch,
    checkout,
    currentBranch,
    headSha
  };
}
