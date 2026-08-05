import type { ModelRouter } from "../llm";
import { createExecutionPlan, type ExecutionPlan } from "./ExecutionPlan";

export interface PlanTaskJson {
  title: string;
  description: string;
  /** 1-based step numbers this task depends on (0-based conversion happens here). */
  dependsOn?: number[];
}

export interface PlannerOptions {
  router: ModelRouter;
  maxTasks?: number;
}

export interface ReplanFailure {
  taskTitle: string;
  reason: string;
}

export interface PlannerEngine {
  /** Build an execution plan for the goal. Degrades to a single task. */
  plan(goal: string, contextSummary: string): Promise<ExecutionPlan>;
  /** Regenerate a plan for the remaining work after a task failed. */
  replan(goal: string, contextSummary: string, failure: ReplanFailure): Promise<ExecutionPlan>;
}

const DEFAULT_MAX_TASKS = 8;
const DEFAULT_MAX_CONTEXT_CHARS = 2000;

/**
 * The model is asked for a single JSON object:
 *   {"plan": [{"title": "...", "description": "...", "dependsOn": [1, 3]}]}
 * dependsOn entries are 1-based step numbers so the model never invents ids.
 */
export function buildPlanPrompt(goal: string, contextSummary: string, maxTasks: number): string {
  return [
    `Goal: ${goal}`,
    "",
    contextSummary ? `Workspace snapshot:\n${contextSummary}` : "Workspace snapshot: (empty)",
    "",
    `Create an execution plan of at most ${maxTasks} steps. Respond with EXACTLY one JSON object, no prose:`,
    '{"plan":[{"title":"short step title","description":"what to do and how to verify","dependsOn":[1,3]}]}',
    "",
    "Rules:",
    "- dependsOn lists the 1-based step numbers that must finish first (omit for none).",
    "- Steps must be concrete and verifiable (tests, typecheck, reading files).",
    "- Do not invent files; inspection steps are fine.",
    "- If the goal is a simple question, a single step is acceptable."
  ].join("\n");
}

/** Parse the model's JSON plan; returns null for prose or invalid shapes. */
export function parsePlanJson(text: string): PlanTaskJson[] | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  const plan =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { plan?: unknown }).plan)
      ? (parsed as { plan: unknown[] }).plan
      : null;
  if (!plan || plan.length === 0) return null;
  const tasks: PlanTaskJson[] = [];
  for (const raw of plan) {
    const step = raw as { title?: unknown; description?: unknown; dependsOn?: unknown };
    if (typeof step.title !== "string" || !step.title.trim()) continue;
    const dependsOn = Array.isArray(step.dependsOn)
      ? step.dependsOn
          .filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 1)
          .slice(0, 32)
      : [];
    tasks.push({
      title: step.title.trim(),
      description:
        typeof step.description === "string" && step.description.trim()
          ? step.description.trim()
          : step.title.trim(),
      dependsOn
    });
  }
  return tasks.length > 0 ? tasks : null;
}

/** Single-task plan used whenever the model cannot produce a plan. */
export function fallbackPlan(goal: string): ExecutionPlan {
  return createExecutionPlan([{ title: `Complete: ${goal}`, description: goal }]);
}

/**
 * Planner as a factory function: turns the user goal into a TaskGraph-backed
 * ExecutionPlan via the model router, converting 1-based dependency numbers
 * into task ids. Every failure mode degrades to a single-task plan.
 */
export function createPlanner(options: PlannerOptions): PlannerEngine {
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;

  async function plan(goal: string, contextSummary: string): Promise<ExecutionPlan> {
    const summary = (contextSummary ?? "").slice(0, DEFAULT_MAX_CONTEXT_CHARS);
    const response = await options.router.complete({
      messages: [
        {
          role: "system",
          content:
            "You are a meticulous software engineering planner. You output only strict JSON execution plans."
        },
        { role: "user", content: buildPlanPrompt(goal, summary, maxTasks) }
      ],
      tools: []
    });
    return toPlan(response.text, goal);
  }

  async function replan(
    goal: string,
    contextSummary: string,
    failure: ReplanFailure
  ): Promise<ExecutionPlan> {
    const summary = (contextSummary ?? "").slice(0, DEFAULT_MAX_CONTEXT_CHARS);
    const response = await options.router.complete({
      messages: [
        {
          role: "system",
          content:
            "You are a meticulous software engineering planner. You output only strict JSON execution plans."
        },
        {
          role: "user",
          content:
            buildPlanPrompt(goal, summary, maxTasks) +
            `\n\nA previous step failed: "${failure.taskTitle}" (${failure.reason}).\nPlan ONLY the remaining work; do not repeat finished steps.`
        }
      ],
      tools: []
    });
    return toPlan(response.text, goal);
  }

  function toPlan(text: string | null, goal: string): ExecutionPlan {
    const parsed = text ? parsePlanJson(text) : null;
    if (!parsed) return fallbackPlan(goal);
    const sliced = parsed.slice(0, maxTasks);
    const tasks = sliced.map((t) => ({
      title: t.title,
      description: t.description,
      dependsOn: t.dependsOn
        ?.filter((n) => n >= 1 && n <= sliced.length)
        .map((n) => `t${n}`)
    }));
    try {
      return createExecutionPlan(tasks);
    } catch {
      return fallbackPlan(goal);
    }
  }

  return { plan, replan };
}
