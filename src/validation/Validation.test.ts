import { describe, expect, it } from "vitest";
import type { Workspace } from "@ai-coding-agent/types";
import {
  createValidationRunner,
  validationFromEnv,
  type ValidationResult
} from "./ValidationRunner";
import { createBuildRunner, createTestRunner, createLintRunner } from "./Runners";
import { buildRepairPrompt, createRepairLoop, hasFailures } from "./RepairLoop";

function makeWorkspace(script: Array<{ exitCode: number; stdout: string; stderr?: string }>): Workspace {
  let i = 0;
  return {
    runCommand: async () => {
      const step = script[Math.min(i++, script.length - 1)] ?? { exitCode: 0, stdout: "" };
      return { exitCode: step.exitCode, stdout: step.stdout, stderr: step.stderr ?? "" };
    }
  } as unknown as Workspace;
}

describe("createValidationRunner", () => {
  it("runs configured checkers and reports pass/fail", async () => {
    const runner = createValidationRunner({
      build: { command: "npm run build" },
      test: { command: "vitest run" },
      lint: { command: "eslint ." }
    });
    const ws = makeWorkspace([
      { exitCode: 0, stdout: "built" },
      { exitCode: 1, stdout: "", stderr: "1 test failed" },
      { exitCode: 0, stdout: "clean" }
    ]);
    const results = await runner.validate(ws);
    expect(results.map((r) => [r.checker, r.status])).toEqual([
      ["build", "passed"],
      ["test", "failed"],
      ["lint", "passed"]
    ]);
    expect(results[1]?.output).toContain("1 test failed");
    expect(runner.enabled()).toBe(true);
  });

  it("is disabled when no checker is configured", () => {
    expect(createValidationRunner({}).enabled()).toBe(false);
  });

  it("reads the environment", () => {
    const config = validationFromEnv({
      VALIDATE_BUILD_CMD: "tsc",
      VALIDATE_LINT_CMD: "eslint"
    } as NodeJS.ProcessEnv);
    expect(config.build?.command).toBe("tsc");
    expect(config.test).toBeUndefined();
  });
});

describe("thin runners", () => {
  it("expose single checkers", async () => {
    const build = createBuildRunner({ command: "make" });
    const test = createTestRunner({ command: "pytest" });
    const lint = createLintRunner({ command: "flake8" });
    expect((await build.validate(makeWorkspace([{ exitCode: 0, stdout: "ok" }])))[0]?.checker).toBe("build");
    expect((await test.validate(makeWorkspace([{ exitCode: 9, stdout: "" }])))[0]?.checker).toBe("test");
    expect((await lint.validate(makeWorkspace([{ exitCode: 0, stdout: "" }])))[0]?.status).toBe("passed");
  });
});

describe("createRepairLoop", () => {
  it("gates only mutating tasks, and skips when disabled", async () => {
    const runner = createValidationRunner({ test: { command: "x" } });
    const loop = createRepairLoop({ validation: runner });
    const ws = makeWorkspace([{ exitCode: 0, stdout: "ok" }]);

    const notMutated = await loop.run({ workspace: ws, mutated: false });
    expect(notMutated.gated).toBe(false);

    const gated = await loop.run({ workspace: ws, mutated: true });
    expect(gated.gated).toBe(true);
    expect(gated.results[0]?.status).toBe("passed");

    const disabled = createRepairLoop({ validation: createValidationRunner({}) });
    expect((await disabled.run({ workspace: ws, mutated: true })).gated).toBe(false);
  });
});

describe("hasFailures / buildRepairPrompt", () => {
  const failed: ValidationResult = { checker: "test", command: "vitest run", exitCode: 1, output: "FAIL x.test.ts", status: "failed" };
  const passed: ValidationResult = { checker: "lint", command: "eslint", exitCode: 0, output: "clean", status: "passed" };

  it("detects failures", () => {
    expect(hasFailures([passed, failed])).toBe(true);
    expect(hasFailures([passed])).toBe(false);
  });

  it("builds a repair prompt listing failed checkers", () => {
    const prompt = buildRepairPrompt([passed, failed]);
    expect(prompt).toMatch(/vitest run/);
    expect(prompt).toMatch(/x\.test\.ts/);
    expect(prompt).toContain("Fix the code");
  });

  it("reports all-clear when nothing failed", () => {
    expect(buildRepairPrompt([passed])).toContain("All checks passed");
  });
});