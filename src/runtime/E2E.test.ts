import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ModelCallResult, SseEvent } from "@ai-coding-agent/types";
import { createConversationService, createMessageStore } from "../conversation";
import type { CompleteParams, ModelRouter } from "../llm";
import { createWorkspaceManager } from "../workspace";
import { createAgentRuntime } from "./AgentRuntime";

/**
 * Phase 10 E2E: conversation → plan → patch → validate ⇒ green in a docker
 * workspace, including one repair iteration (first patch fails the test
 * checker, the repair prompt drives a second patch that passes).
 */

function result(text: string | null, toolCalls: ModelCallResult["toolCalls"] = []): ModelCallResult {
  return { text, toolCalls, usage: { inputTokens: 5, outputTokens: 5, model: "scripted", provider: "test" } };
}

/** Deterministic model: reacts to the prompt kind instead of a fixed turn order. */
function scriptedRouter(): ModelRouter {
  let call = 0;
  return {
    available: () => [],
    async complete(params: CompleteParams): Promise<ModelCallResult> {
      call++;
      const last = params.messages.at(-1)!;
      if (last.content.includes("Create an execution plan")) {
        return result('{"plan":[{"title":"Write app.txt","description":"write app.txt so the test passes"}]}');
      }
      if (last.content.includes("[Validation]")) {
        // repair iteration: fix the file so `grep -q ok` succeeds
        return result(null, [{ id: `c${call}`, name: "write_file", input: { path: "app.txt", content: "ok\n" } }]);
      }
      if (last.role === "tool") {
        return result("task attempt finished");
      }
      if (last.content.includes("[Plan task")) {
        // first attempt writes the WRONG content on purpose
        return result(null, [{ id: `c${call}`, name: "write_file", input: { path: "app.txt", content: "wrong\n" } }]);
      }
      return result("done");
    }
  };
}

describe("E2E (docker)", () => {
  it(
    "conversation → plan → patch → validate with a repair iteration goes green",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "aca-e2e-"));
      const store = createMessageStore();
      const workspaces = createWorkspaceManager();
      const runtime = createAgentRuntime({
        router: scriptedRouter(),
        validation: { test: { command: "grep -q ok app.txt" } }
      });
      const service = createConversationService({ runtime, store, workspaces });
      const conversation = await service.create({ root, workspaceKind: "docker" });

      const events: SseEvent[] = [];
      const approve = (callId: string): void => {
        // the confirm_request event fires just before the pending entry exists
        if (!service.confirm(conversation.id, callId, true)) {
          setTimeout(() => approve(callId), 10);
        }
      };

      await service.streamMessage(conversation.id, "make app.txt contain ok", {
        emit: (event) => {
          events.push(event);
          if (event.type === "agent.confirm_request") approve(event.callId);
        }
      });

      // plan was emitted
      expect(events.find((e) => e.type === "agent.plan")).toBeDefined();
      // two write attempts, both confirmed
      expect(events.filter((e) => e.type === "agent.confirm_request")).toHaveLength(2);
      // validation failed once (repair trigger), then passed
      const validations = events.filter((e) => e.type === "agent.validation");
      expect(validations.map((v) => v.status)).toEqual(["failed", "passed"]);
      // run completed
      expect(events.at(-1)?.type).toBe("agent.done");
      // the workspace really contains the fixed file
      const workspace = service.getWorkspace(conversation.id);
      expect(await workspace.readFile("app.txt")).toBe("ok\n");

      await service.destroy(conversation.id);
      await rm(root, { recursive: true, force: true });
    },
    120_000
  );
});
