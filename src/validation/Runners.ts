import {
  createValidationRunner,
  type ValidationCommand,
  type ValidationRunner
} from "./ValidationRunner";

/** Thin wrappers matching the HLD runner names; single-checker ValidationRunners. */
export function createBuildRunner(command: ValidationCommand): ValidationRunner {
  return createValidationRunner({ build: command });
}

export function createTestRunner(command: ValidationCommand): ValidationRunner {
  return createValidationRunner({ test: command });
}

export function createLintRunner(command: ValidationCommand): ValidationRunner {
  return createValidationRunner({ lint: command });
}