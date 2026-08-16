import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import type { CommandResult, Workspace } from "@ai-coding-agent/types";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 200_000;
const MAX_COMMAND_CHARS = 10_000;

/**
 * Firecracker workspaces drive microVMs through a runner CLI named by
 * FIRECRACKER_BIN (typically a thin wrapper around the firecracker binary +
 * a vsock exec agent). Expected subcommand contract:
 *
 *   $BIN boot     --id <vmId> --root <hostDir> [--snapshot <snapshotId>]
 *   $BIN exec     --id <vmId> -- <shell command>       (stdout/stderr/exit pass through)
 *   $BIN snapshot --id <vmId>                          (prints a snapshot id)
 *   $BIN teardown --id <vmId>
 *
 * Opt-in by design: without FIRECRACKER_BIN, WorkspaceManager keeps refusing
 * the "firecracker" kind so local + docker work with no elevated privileges.
 */
export interface FirecrackerWorkspaceOptions {
  id: string;
  /** Host directory shared into the microVM (virtiofs in a real deployment). */
  root: string;
  /** Runner binary; defaults to process.env.FIRECRACKER_BIN. */
  bin?: string;
  /** Existing VM id (re-attach); a fresh one is derived from `id` otherwise. */
  vmId?: string;
  /** Boot from this snapshot instead of the base image. */
  snapshotId?: string;
  commandTimeoutMs?: number;
  /** Idle VM teardown TTL; the VM is snapshotted and rebooted on demand. */
  idleTtlMs?: number;
}

export interface FirecrackerWorkspace extends Workspace {
  readonly vmId: string;
  /** Snapshot taken at the last suspend/destroy (undefined while running fresh). */
  readonly snapshotId: string | undefined;
  /** vmId@snapshotId encoding for the workspace store record. */
  recordHandle(): string;
}

/** Splits a stored `vmId@snapshotId` handle back into its parts. */
export function parseFirecrackerHandle(handle: string): { vmId: string; snapshotId?: string } {
  const [vmId, snapshotId] = handle.split("@");
  return { vmId: vmId ?? handle, snapshotId: snapshotId || undefined };
}

export async function createFirecrackerWorkspace(
  options: FirecrackerWorkspaceOptions
): Promise<FirecrackerWorkspace> {
  const bin = options.bin ?? process.env.FIRECRACKER_BIN;
  if (!bin) {
    throw new Error("Firecracker workspaces need FIRECRACKER_BIN (runner CLI) to be set");
  }
  const vmId = options.vmId ?? `fc-${options.id.slice(0, 12)}`;
  const root = path.resolve(options.root);
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  const idleTtlMs = options.idleTtlMs ?? 10 * 60_000;

  let snapshotId: string | undefined = options.snapshotId;
  let running = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  async function runner(args: string[], timeoutMs = commandTimeoutMs): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(bin!, args, {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT + 1024
      });
      return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : e.killed ? 124 : 1,
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? String(err))
      };
    }
  }

  async function boot(): Promise<void> {
    const args = ["boot", "--id", vmId, "--root", root];
    if (snapshotId) args.push("--snapshot", snapshotId);
    const res = await runner(args, 120_000);
    if (res.exitCode !== 0) {
      throw new Error(`firecracker boot failed: ${(res.stderr || res.stdout).trim()}`);
    }
    running = true;
  }

  async function suspend(): Promise<void> {
    if (!running) return;
    const snap = await runner(["snapshot", "--id", vmId], 60_000);
    if (snap.exitCode === 0 && snap.stdout.trim()) snapshotId = snap.stdout.trim();
    await runner(["teardown", "--id", vmId], 60_000);
    running = false;
  }

  function armIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void suspend();
    }, idleTtlMs);
    idleTimer.unref?.();
  }

  async function exec(command: string): Promise<CommandResult> {
    if (destroyed) return { exitCode: 1, stdout: "", stderr: "workspace destroyed" };
    if (command.length > MAX_COMMAND_CHARS) {
      return { exitCode: 1, stdout: "", stderr: `Command too long (${command.length} chars, max ${MAX_COMMAND_CHARS})` };
    }
    if (!running) await boot(); // reboot from the last snapshot on demand
    armIdleTimer();
    const res = await runner(["exec", "--id", vmId, "--", command]);
    const truncate = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) : s);
    return {
      exitCode: res.exitCode,
      stdout: truncate(res.stdout),
      stderr: truncate(res.stderr),
      truncated: res.stdout.length > MAX_OUTPUT || res.stderr.length > MAX_OUTPUT
    };
  }

  function quote(p: string): string {
    return "'" + p.replace(/'/g, `'\\''`) + "'";
  }

  await fs.mkdir(root, { recursive: true });
  await boot();
  armIdleTimer();

  return {
    id: options.id,
    kind: "firecracker",
    rootPath: root,
    vmId,
    get snapshotId() {
      return snapshotId;
    },
    recordHandle() {
      return snapshotId ? `${vmId}@${snapshotId}` : vmId;
    },
    async readFile(p) {
      const res = await exec(`cat ${quote(p)}`);
      if (res.exitCode !== 0) throw new Error(`readFile failed: ${res.stderr}`);
      return res.stdout;
    },
    async writeFile(p, content) {
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const res = await exec(`mkdir -p ${quote(path.posix.dirname(p))} && echo ${b64} | base64 -d > ${quote(p)}`);
      if (res.exitCode !== 0) throw new Error(`writeFile failed: ${res.stderr}`);
    },
    async listDir(p = "") {
      const dir = p || ".";
      const res = await exec(`cd ${quote(dir)} && ls -1A && echo ===DIRS=== && ls -1Ad */ 2>/dev/null || true`);
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
      return exec(cwd ? `cd ${quote(cwd)} && ${command}` : command);
    },
    async gitStatus() {
      const res = await exec("git status --porcelain -b 2>&1");
      if (res.exitCode !== 0) return { branch: "", modified: [], untracked: [] };
      const modified: string[] = [];
      const untracked: string[] = [];
      let branch = "";
      for (const line of res.stdout.split("\n")) {
        if (line.startsWith("## ")) branch = line.slice(3).split("...")[0] ?? "";
        else if (line.startsWith("??")) untracked.push(line.slice(3).trim());
        else if (line.trim()) modified.push(line.trim());
      }
      return { branch, modified, untracked };
    },
    async gitDiff(p) {
      const res = await exec(`git diff -- ${p ?? ""}`.trim());
      return res.stdout;
    },
    async destroy() {
      destroyed = true;
      if (idleTimer) clearTimeout(idleTimer);
      await suspend(); // snapshot survives; VM is torn down
    }
  };
}

/** Re-attach from a stored `vmId@snapshotId` handle (rehydration). */
export async function attachFirecrackerWorkspace(options: {
  id: string;
  root: string;
  handle: string;
  bin?: string;
  commandTimeoutMs?: number;
  idleTtlMs?: number;
}): Promise<FirecrackerWorkspace> {
  const { vmId, snapshotId } = parseFirecrackerHandle(options.handle);
  return createFirecrackerWorkspace({
    id: options.id,
    root: options.root,
    bin: options.bin,
    vmId,
    snapshotId,
    commandTimeoutMs: options.commandTimeoutMs,
    idleTtlMs: options.idleTtlMs
  });
}
