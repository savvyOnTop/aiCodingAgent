import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { createDockerWorkspace } from "./DockerWorkspace";

let dockerAvailable = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

const describeDocker = dockerAvailable ? describe : describe.skip;

describeDocker("DockerWorkspace", () => {
  it("writes, reads, lists and executes in the container", async () => {
    const ws = await createDockerWorkspace({
      id: "ws-docker-test",
      root: process.cwd() + "/dist/.docker-ws-test"
    });
    try {
      await ws.writeFile("src/a.txt", "hello container");
      expect(await ws.readFile("src/a.txt")).toBe("hello container");
      const entries = await ws.listDir("src");
      expect(entries).toContainEqual({ name: "a.txt", path: "src/a.txt", type: "file" });
      const res = await ws.runCommand("pwd");
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("/workspace");
    } finally {
      await ws.destroy();
    }
  });

  it("reports git status from inside the container", async () => {
    const ws = await createDockerWorkspace({
      id: "ws-docker-git",
      root: process.cwd() + "/dist/.docker-ws-git"
    });
    try {
      const status = await ws.gitStatus();
      expect(status).toEqual({ branch: "", modified: [], untracked: [] });
    } finally {
      await ws.destroy();
    }
  });
});
