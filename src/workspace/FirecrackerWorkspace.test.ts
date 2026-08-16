import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachFirecrackerWorkspace, createFirecrackerWorkspace, parseFirecrackerHandle } from "./FirecrackerWorkspace";

/**
 * Unit tests run against a stub runner CLI implementing the documented
 * contract (boot/exec/snapshot/teardown), so no microVM is needed. The same
 * suite exercises a real runner when FIRECRACKER_BIN is set in the env.
 */

let dir: string;
let bin: string;
let logFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "aca-fc-"));
  bin = process.env.FIRECRACKER_BIN ?? path.join(dir, "fc-runner.sh");
  logFile = path.join(dir, "runner.log");
  if (!process.env.FIRECRACKER_BIN) {
    const script = `#!/bin/sh
LOG="${logFile}"
STATE="${dir}/state"
mkdir -p "$STATE"
cmd="$1"; shift
case "$cmd" in
  boot)
    echo "boot $@" >> "$LOG"
    id=""; root=""; snap=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --id) id="$2"; shift 2;;
        --root) root="$2"; shift 2;;
        --snapshot) snap="$2"; shift 2;;
        *) shift;;
      esac
    done
    echo "$root" > "$STATE/$id.root"
    ;;
  exec)
    echo "exec $@" >> "$LOG"
    id=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --id) id="$2"; shift 2;;
        --) shift; break;;
        *) shift;;
      esac
    done
    root=$(cat "$STATE/$id.root")
    cd "$root" && sh -c "$*"
    ;;
  snapshot)
    echo "snapshot $@" >> "$LOG"
    n=$(grep -c '^snapshot' "$LOG")
    echo "snap-$n"
    ;;
  teardown)
    echo "teardown $@" >> "$LOG"
    ;;
esac
`;
    await writeFile(bin, script);
    await chmod(bin, 0o755);
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runnerLog(): Promise<string> {
  try {
    return await readFile(logFile, "utf8");
  } catch {
    return "";
  }
}

describe("FirecrackerWorkspace (stub runner; real when FIRECRACKER_BIN set)", () => {
  it("boots, runs commands, snapshots on destroy, and re-attaches", async () => {
    const root = path.join(dir, "root1");
    const ws = await createFirecrackerWorkspace({ id: "vm-test-1", root, bin });
    expect((await runnerLog())).toContain("boot");

    await ws.writeFile("hello.txt", "from the vm\n");
    expect(await ws.readFile("hello.txt")).toBe("from the vm\n");
    const res = await ws.runCommand("echo running");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("running");

    await ws.destroy();
    const log = await runnerLog();
    expect(log).toContain("snapshot");
    expect(log).toContain("teardown");
    expect(ws.snapshotId).toBeDefined();
    const handle = ws.recordHandle();
    expect(handle).toContain("@");

    // re-attach from the stored handle: boots from the snapshot
    const attached = await attachFirecrackerWorkspace({ id: "vm-test-1", root, handle, bin });
    expect((await runnerLog())).toContain(`--snapshot ${ws.snapshotId}`);
    expect(await attached.readFile("hello.txt")).toBe("from the vm\n");
    await attached.destroy();
  });

  it("tears down idle VMs after the TTL and reboots on demand", async () => {
    const root = path.join(dir, "root2");
    const ws = await createFirecrackerWorkspace({ id: "vm-idle", root, bin, idleTtlMs: 60 });
    await ws.writeFile("keep.txt", "state\n");

    await new Promise((resolve) => setTimeout(resolve, 200));
    const log = await runnerLog();
    expect(log).toContain("teardown --id fc-vm-idle");

    // next command reboots (from the idle snapshot) and still works
    const res = await ws.runCommand("cat keep.txt");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("state\n");
    const boots = (await runnerLog()).split("\n").filter((l) => l.startsWith("boot")).length;
    expect(boots).toBeGreaterThanOrEqual(2);
    await ws.destroy();
  });

  it("parses record handles", () => {
    expect(parseFirecrackerHandle("vm-1@snap-3")).toEqual({ vmId: "vm-1", snapshotId: "snap-3" });
    expect(parseFirecrackerHandle("vm-1")).toEqual({ vmId: "vm-1", snapshotId: undefined });
  });
});
