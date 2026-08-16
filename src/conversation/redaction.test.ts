import { describe, expect, it } from "vitest";
import type { ToolContext } from "@ai-coding-agent/types";
import { createToolRegistry } from "../runtime";
import { createSecretRedactor } from "./redaction";

describe("createSecretRedactor", () => {
  it("redacts values of hint-matching env vars", () => {
    const redact = createSecretRedactor({
      MY_API_KEY: "sk-verysecret123",
      GITHUB_TOKEN: "ghp_abcdef123456",
      SAFE_SETTING: "visible-value"
    });
    const out = redact("key=sk-verysecret123 token=ghp_abcdef123456 cfg=visible-value");
    expect(out).toBe("key=*** token=*** cfg=visible-value");
  });

  it("redacts blocklisted names that miss the hint pattern", () => {
    const redact = createSecretRedactor({ DATABASE_URL: "postgres://user:pw@host/db" });
    expect(redact("dsn is postgres://user:pw@host/db")).toBe("dsn is ***");
  });

  it("ignores short values (too collision-prone to scrub)", () => {
    const redact = createSecretRedactor({ PIN_SECRET: "1234" });
    expect(redact("code 1234 stays")).toBe("code 1234 stays");
  });

  it("handles overlapping secrets longest-first", () => {
    const redact = createSecretRedactor({
      LONG_TOKEN: "abcdef-ghijkl",
      SHORT_TOKEN: "abcdef"
    });
    expect(redact("x abcdef-ghijkl y abcdef z")).toBe("x *** y *** z");
  });
});

describe("central tool-output redaction (ToolRegistry)", () => {
  it("scrubs secrets from any tool's output, even without ctx.redact use", async () => {
    const registry = createToolRegistry();
    registry.register({
      name: "leaky",
      description: "returns a secret",
      requiresConfirmation: false,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => ({ status: "success", output: "the secret is hunter2secret!" })
    });
    const redact = createSecretRedactor({ APP_PASSWORD: "hunter2secret" });
    const ctx = { workspace: {}, sessionId: "s", cwd: ".", redact } as unknown as ToolContext;

    const result = await registry.execute("leaky", {}, ctx);
    expect(result.output).toBe("the secret is ***!");
    expect(result.output).not.toContain("hunter2secret");
  });

  it("scrubs secrets from tool error messages too", async () => {
    const registry = createToolRegistry();
    registry.register({
      name: "thrower",
      description: "throws with a secret",
      requiresConfirmation: false,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => {
        throw new Error("connect failed for token hunter2secret");
      }
    });
    const redact = createSecretRedactor({ APP_PASSWORD: "hunter2secret" });
    const ctx = { workspace: {}, sessionId: "s", cwd: ".", redact } as unknown as ToolContext;

    const result = await registry.execute("thrower", {}, ctx);
    expect(result.status).toBe("error");
    expect(result.output).not.toContain("hunter2secret");
  });
});
