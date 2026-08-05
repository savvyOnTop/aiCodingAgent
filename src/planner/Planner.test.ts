import { describe, expect, it } from "vitest";
import type { ModelRouter } from "../llm";
import { createPlanner, parsePlanJson } from "./Planner";
import { createExecutionPlan, type ExecutionPlan } from "./ExecutionPlan";

function fakeRouter(text: string | null): ModelRouter {
  return {
    available: () => [],
    complete: async () => ({
      text,
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, model: "fake", provider: "fake" }
    })
  };
}

describe("parsePlanJson", () => {
  it("parses fenced JSON with 1-based numeric dependencies", () => {
    const text = '```json\n{"plan":[{"title":"Inspect","description":"look around"},{"title":"Edit","description":"change it","dependsOn":[1]}]}\n```';
    const plan = parsePlanJson(text);
    expect(plan?.[0]?.title).toBe("Inspect");
    expect(plan?.[1]?.dependsOn).toEqual([1]);
  });

  it("parses plain JSON without fences", () => {
    const plan = parsePlanJson('{"plan":[{"title":"T","description":"D"}]}');
    expect(plan).toHaveLength(1);
    expect(plan?.[0]?.title).toBe("T");
  });

  it("returns null for prose", () => {
    expect(parsePlanJson("I will start by looking at the files.")).toBeNull();
  });

  it("ignores malformed steps and drops bad dependency refs", () => {
    const plan = parsePlanJson(
      '{"plan":[{"description":"no title"},{"title":"Good","description":"ok","dependsOn":[0,-1,2,"x"]}]}'
    );
    expect(plan?.[0]?.title).toBe("Good");
    expect(plan?.[0]?.dependsOn).toEqual([2]);
  });
});

describe("createPlanner", () => {
  it("builds an execution plan with dependencies converted to ids", async () => {
    const router = fakeRouter('{"plan":[{"title":"A"},{"title":"B","dependsOn":[1]},{"title":"C","dependsOn":[1,2]}]}');
    const chain = createPlanner({ router });
    const plan = await chain.plan("Do the thing", "tree...");
    expect(plan.steps()).toEqual(["A", "B", "C"]);
    const order = plan.remaining().map((t) => t.title);
    expect(order).toEqual(["A", "B", "C"]);
    expect(plan.next()?.title).toBe("A");
  });

  it("falls back to a single task when the model replies with prose", async () => {
    const chain = createPlanner({ router: fakeRouter("sure, I will handle that") });
    const plan = await chain.plan("Do it", "");
    expect(plan.steps()).toHaveLength(1);
    expect(plan.steps()[0]).toMatch(/Do it/);
  });

  it("caps the number of tasks", async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => JSON.stringify({ title: `T${i}` })).join(",");
    const chain = createPlanner({ router: fakeRouter(`{"plan":[${tasks}]}`), maxTasks: 3 });
    const plan = await chain.plan("g", "");
    expect(plan.steps()).toHaveLength(3);
  });

  it("replans remaining work and toggles statuses", async () => {
    const router = fakeRouter('{"plan":[{"title":"A"},{"title":"B","dependsOn":[1]}]}');
    const chain = createPlanner({ router });
    const plan = await chain.plan("g", "");
    const first = plan.next()!;
    plan.markRunning(first.id);
    plan.markDone(first.id);
    expect(plan.next()?.title).toBe("B");
    const revised = await chain.replan("g", "", { taskTitle: "B", reason: "boom" });
    expect(revised.steps()).toEqual(["A", "B"]);
  });
});

describe("createExecutionPlan", () => {
  it("only returns a task once all dependencies are done", () => {
    const plan: ExecutionPlan = createExecutionPlan([
      { title: "A", description: "" },
      { title: "B", description: "", dependsOn: ["t1"] }
    ]);
    expect(plan.next()?.title).toBe("A");
    plan.markRunning("t1");
    plan.markDone("t1");
    expect(plan.next()?.title).toBe("B");
    plan.markRunning("t2");
    plan.markDone("t2");
    expect(plan.isComplete()).toBe(true);
    expect(plan.remaining()).toHaveLength(0);
  });

  it("serializes a stable snapshot", () => {
    const plan = createExecutionPlan([{ title: "A", description: "" }]);
    expect(plan.serialize()).toEqual([{ title: "A", status: "pending", dependsOn: [] }]);
  });
});