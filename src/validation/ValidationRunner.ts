import type { Workspace } from "@ai-coding-agent/types";

export type ValidationChecker = "build" | "test" | "lint";

export interface ValidationCommand {
  command: string;
  timeoutMs?: number;
}

export interface ValidationConfig {
  build?: ValidationCommand;
  test?: ValidationCommand;
  lint?: ValidationCommand;
}

export interface ValidationResult {
  checker: ValidationChecker;
  command: string;
  exitCode: number;
  output: string;
  status: "passed" | "failed";
}

export interface ValidationRunner {
  enabled(): boolean;
  /** Run every configured checker in order; stops early on abort. */
  validate(workspace: Workspace, signal?: AbortSignal): Promise<ValidationResult[]>;
}

const OUTPUT_CAP = 4000;

/**
 * ValidationRunner as a factory function: runs each configured checker
 * (build/test/lint) via the workspace's shell. A nonzero exit code means
 * failed; output is capped so failures can be fed back to the model without
 * flooding the transcript.
 */
export function createValidationRunner(config: ValidationConfig): ValidationRunner {
  const checkers = (["build", "test", "lint"] as const).filter((c) => config[c]);

  function enabled(): boolean {
    return checkers.length > 0;
  }

  async function validate(workspace: Workspace, signal?: AbortSignal): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    for (const checker of checkers) {
      if (signal?.aborted) break;
      const entry = config[checker]!;
      const res = await workspace.runCommand(entry.command, ".");
      const output = `${res.stdout}\n${res.stderr}`.trim().slice(0, OUTPUT_CAP);
      results.push({
        checker,
        command: entry.command,
        exitCode: res.exitCode,
        status: res.exitCode === 0 ? "passed" : "failed",
        output
      });
    }
    return results;
  }

  return { enabled, validate };
}

/** Read checker commands from the environment (VALIDATE_BUILD_CMD etc.). */
export function validationFromEnv(env: NodeJS.ProcessEnv = process.env): ValidationConfig {
  const config: ValidationConfig = {};
  if (env.VALIDATE_BUILD_CMD) config.build = { command: env.VALIDATE_BUILD_CMD };
  if (env.VALIDATE_TEST_CMD) config.test = { command: env.VALIDATE_TEST_CMD };
  if (env.VALIDATE_LINT_CMD) config.lint = { command: env.VALIDATE_LINT_CMD };
  return config;
}