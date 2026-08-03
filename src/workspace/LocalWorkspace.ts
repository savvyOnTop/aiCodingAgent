import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import type { CommandResult, FileEntry, GitStatusResult, Workspace } from "@ai-coding-agent/types";

const execFileAsync = promisify(execFile);

export interface LocalWorkspaceOptions {
  id: string;
  root: string;
  shell?: string;
  commandTimeoutMs?: number;
  maxOutputChars?: number;
}

const MAX_OUTPUT = 200_000;

/**
 * Host-directory workspace as a factory function. All paths are resolved
 * against the workspace root and traversal outside it is rejected; commands
 * run with the root as cwd.
 */
export function createLocalWorkspace(options: LocalWorkspaceOptions): Workspace & { getRoot(): string } {
  const root = path.resolve(options.root);
  const shell = options.shell ?? "bash";
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;

  function resolve(p: string): string {
    //checks if path is absolute like /Users/sagar/project/src/App.tsx is absolute but project/src/App.tsx is not
    if (path.isAbsolute(p)) {
      // this removes extra . or .. or / from the path example /Users/sagar/project/src//App.tsx becmoes /Users/sagar/project/src/App.tsx
      const absolute = path.normalize(p);
      if (!isInside(absolute)) {
        throw new Error(`Path escapes workspace root: ${p}`);
      }
      return absolute;
    }
    const target = path.resolve(root, p);
    // it resolves resolve("../project/package.json") in to /Users/sagar/project/package.json

    if (!isInside(target)) {
      throw new Error(`Path escapes workspace root: ${p}`);
    }
    return target;
  }

  function isInside(target: string): boolean {
    // here the root is checked for ending with / =>  /Users/sagar/project/
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;

    // true will go if  /Users/sagar/project/src/App.tsx starts with /Users/sagar/project/ and it does
    return target === root || target.startsWith(rootWithSep);
  }

  async function readFile(p: string): Promise<string> {
    return fs.readFile(resolve(p), "utf8");
  }

  async function writeFile(p: string, content: string): Promise<void> {
    const target = resolve(p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }

  async function listDir(p = ""): Promise<FileEntry[]> {
    const target = resolve(p);
    const dirents = await fs.readdir(target, { withFileTypes: true });
    return dirents.map((d) => ({
      name: d.name,
      path: path.join(p, d.name).replace(/\\/g, "/"),
      type: d.isDirectory() ? "dir" : "file"
    }));
  }

  function trim(result: CommandResult): CommandResult {
    const truncate = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) : s);
    return {
      exitCode: result.exitCode,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      truncated: result.stdout.length > MAX_OUTPUT || result.stderr.length > MAX_OUTPUT
    };
  }

  async function runCommand(command: string, cwd?: string): Promise<CommandResult> {
    const dir = cwd ? resolve(cwd) : root;
    try {
      const { stdout, stderr } = await execFileAsync(shell, ["-lc", command], {
        cwd: dir,
        timeout: commandTimeoutMs,
        maxBuffer: MAX_OUTPUT + 1024,
        env: process.env
      });
      return trim({ exitCode: 0, stdout, stderr });
    } catch (err) {
      const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
      return trim({
        exitCode: typeof e.code === "number" ? e.code : e.killed ? 124 : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(e)
      });
    }
  }

  async function gitStatus(): Promise<GitStatusResult> {
    const res = await runCommand("git status --porcelain -b 2>&1");
    if (res.exitCode !== 0) return { branch: "", modified: [], untracked: [] };
    const modified: string[] = [];
    const untracked: string[] = [];
    let branch = "";
    for (const line of res.stdout.split("\n")) {
      if (line.startsWith("## ")) {
        branch = line.slice(3).split("...")[0] ?? "";
      } else if (line.startsWith("??")) {
        untracked.push(line.slice(3).trim());
      } else if (line.trim()) {
        modified.push(line.trim());
      }
    }
    return { branch, modified, untracked };
  }

  async function gitDiff(p?: string): Promise<string> {
    const res = await runCommand(`git diff -- ${p ?? ""}`.trim());
    return res.stdout;
  }

  return {
    id: options.id,
    kind: "local",
    getRoot: () => root,
    readFile,
    writeFile,
    listDir,
    runCommand,
    gitStatus,
    gitDiff,
    destroy: async () => {}
  };
}
