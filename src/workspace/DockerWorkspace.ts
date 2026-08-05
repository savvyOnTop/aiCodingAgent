import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import type { CommandResult, Workspace } from "@ai-coding-agent/types";

const execFileAsync = promisify(execFile);

export interface DockerWorkspaceOptions {
  id: string;
  /** Host directory mounted into the container as /workspace. */
  root: string;
  image?: string;
  containerName?: string;
  commandTimeoutMs?: number;
  maxOutputChars?: number;
}

const MAX_OUTPUT = 200_000;
const MOUNT_PATH = "/workspace";
const MAX_COMMAND_CHARS = 10_000;

function runDocker(args: string[], timeoutMs: number): ReturnType<typeof execFileAsync> {
  return execFileAsync("docker", args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT + 1024 });
}

function quote(posixPath: string): string {
  return "'" + posixPath.replace(/'/g, `'\\''`) + "'";
}

function readStderr(err: { stderr?: string; stdout?: string; message?: string }): string {
  return err.stderr?.trim() || err.stdout?.trim() || String(err.message ?? err);
}

/**
 * Isolated workspace: every file operation and command runs inside a Docker
 * container with the host directory mounted at /workspace. One container is
 * created per workspace and removed on destroy.
 */
export function createDockerWorkspace(
  options: DockerWorkspaceOptions
): Promise<Workspace & { containerName: string; rootPath: string }> {
  return (async () => {
    const image = options.image ?? "node:22-alpine";
    const containerName =
      options.containerName ?? `aca-${options.id.slice(0, 12)}`;
    const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    const root = path.resolve(options.root);
    await fs.mkdir(root, { recursive: true });

    try {
      await runDocker(["run", "-d", "--name", containerName, "-v", `${root}:${MOUNT_PATH}`, "-w", MOUNT_PATH, image, "sleep", "infinity"], 120_000);
    } catch (err) {
      const message = readStderr(err as { stderr?: string });
      if (/Unable to find image|not found/i.test(message)) {
        try {
          await runDocker(["pull", image], 300_000);
          await runDocker(["run", "-d", "--name", containerName, "-v", `${root}:${MOUNT_PATH}`, "-w", MOUNT_PATH, image, "sleep", "infinity"], 120_000);
        } catch (pullErr) {
          throw new Error(`Docker workspace failed (image ${image}): ${readStderr(pullErr as { stderr?: string })}`);
        }
      } else {
        throw new Error(`Docker workspace failed to start: ${message}`);
      }
    }

    async function exec(command: string): Promise<CommandResult> {
      if (command.length > MAX_COMMAND_CHARS) {
        return { exitCode: 1, stdout: "", stderr: `Command too long (${command.length} chars, max ${MAX_COMMAND_CHARS})` };
      }
      try {
        const { stdout, stderr } = await runDocker(
          ["exec", containerName, "sh", "-lc", command],
          commandTimeoutMs
        );
        return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
      } catch (err) {
        const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
        return {
          exitCode: typeof e.code === "number" ? e.code : e.killed ? 124 : 1,
          stdout: String(e.stdout ?? ""),
          stderr: String(e.stderr ?? "")
        };
      }
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

    return {
      id: options.id,
      kind: "docker" as const,
      rootPath: MOUNT_PATH,
      containerName,
      async readFile(p) {
        const res = await exec(`cat ${quote(p)}`);
        if (res.exitCode !== 0) throw new Error(`readFile failed: ${res.stderr}`);
        return res.stdout;
      },
      async writeFile(p, content) {
        const b64 = Buffer.from(content, "utf8").toString("base64");
        const res = await exec(
          `mkdir -p ${quote(path.dirname(p))} && echo ${b64} | base64 -d > ${quote(p)}`
        );
        if (res.exitCode !== 0) throw new Error(`writeFile failed: ${res.stderr}`);
      },
      async listDir(p = "") {
        const dir = p || ".";
        const res = await exec(
          `cd ${quote(dir)} && ls -1A && echo ===DIRS=== && ls -1Ad */ 2>/dev/null || true`
        );
        if (res.exitCode !== 0) throw new Error(`listDir failed: ${res.stderr}`);
        const [listing, dirsRaw] = res.stdout.split("===DIRS===");
        const dirs = new Set(
          (dirsRaw ?? "")
            .split("\n")
            .map((d) => d.replace(/\/$/, ""))
            .filter(Boolean)
        );
        return (listing ?? "")
          .split("\n")
          .filter(Boolean)
          .map((name) => ({
            name,
            path: path.posix.join(p, name),
            type: dirs.has(name) ? ("dir" as const) : ("file" as const)
          }));
      },
      async runCommand(command, cwd) {
        const prefixed = cwd ? `cd ${quote(cwd)} && ${command}` : command;
        return trim(await exec(prefixed));
      },
      async gitStatus() {
        const res = await exec("git status --porcelain -b 2>&1");
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
      },
      async gitDiff(p) {
        const res = await exec(`git diff -- ${p ?? ""}`.trim());
        return res.stdout;
      },
      async destroy() {
        await runDocker(["rm", "-f", containerName], 30_000).catch(() => {});
      }
    };
  })();
}
