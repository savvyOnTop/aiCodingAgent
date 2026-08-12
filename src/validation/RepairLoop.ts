import type { Workspace } from "@ai-coding-agent/types";
import type { ValidationResult, ValidationRunner } from "./ValidationRunner";

export interface RepairLoopOptions {
  validation: Pick<ValidationRunner, "enabled" | "validate">;
}

export interface RepairLoopInput {
  workspace: Workspace;
  signal?: AbortSignal;
  /** Only gate when the task actually changed something. */
  mutated: boolean;
}

export interface RepairLoopRun {
  gated: boolean;
  results: ValidationResult[];
}

export interface RepairLoop {
  /**
   * Run the validation gates when the task mutated files. AgentLoop calls
   * this before accepting a task's final answer; failures are fed back as a
   * repair prompt so the model fixes rather than stops.
   */
  run(input: RepairLoopInput): Promise<RepairLoopRun>;
}

/**
 * RepairLoop as a factory function: the validation gate that turns a failed
 * check into a continuation signal for the agent loop. When the runner is
 * disabled or the task touched nothing, it reports no results.
 */
export function createRepairLoop(options: RepairLoopOptions): RepairLoop {
  const { validation } = options;

  async function run(input: RepairLoopInput): Promise<RepairLoopRun> {
    if (!validation.enabled() || !input.mutated) {
      return { gated: false, results: [] };
    }
    const results = await validation.validate(input.workspace, input.signal);
    return { gated: true, results };
  }

  return { run };
}

/** True when any checker reported a failure. */
export function hasFailures(results: ValidationResult[]): boolean {
  return results.some((r) => r.status === "failed");
}

/**
 * Compact, model-facing summary of the failed checks. Every checker is listed
 * but failures carry up to 1500 chars of output so the model can diagnose.
 */
export function buildRepairPrompt(results: ValidationResult[]): string {
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length === 0) {
    return `[Validation] All checks passed:\n${results.map((r) => `- ${r.checker}: passed`).join("\n")}`;
  }
  const lines = failed.map((r) => {
    const tail = r.output.length > 1500 ? `${r.output.slice(-1500)}\n[truncated]` : r.output;
    return `- ${r.checker}: "${r.command}" failed (exit ${r.exitCode})\n${tail}`;
  });
  return `[Validation] The following checks failed. Fix the code so they pass before concluding.\n${lines.join("\n\n")}`;
}