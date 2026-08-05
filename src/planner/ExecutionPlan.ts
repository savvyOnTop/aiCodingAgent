import { createTaskGraph, type TaskGraph, type TaskInput, type TaskNode } from "./TaskGraph";

export interface PlanStep {
  title: string;
  status: TaskNode["status"];
  dependsOn: string[];
}

export interface ExecutionPlan {
  graph: TaskGraph;
  /** First not-done task whose dependencies are all done; null when finished. */
  next(): TaskNode | null;
  markRunning(id: string): void;
  markDone(id: string): void;
  markFailed(id: string): void;
  /** Remaining tasks in dependency order (pending or failed). */
  remaining(): TaskNode[];
  isComplete(): boolean;
  /** Task titles in dependency order, for the agent.plan SSE event. */
  steps(): string[];
  /** Stable snapshot for debugging / UI. */
  serialize(): PlanStep[];
}

/**
 * ExecutionPlan as a factory function: a TaskGraph plus positional control
 * helpers. The graph owns ordering; the plan owns "what runs next" state.
 */
export function createExecutionPlan(tasks: TaskInput[]): ExecutionPlan {
  const graph = createTaskGraph();
  for (const task of tasks) graph.addTask({ ...task, dependsOn: task.dependsOn ?? [] });

  function next(): TaskNode | null {
    const done = (id: string): boolean => graph.get(id)?.status === "done";
    for (const task of graph.topologicalOrder()) {
      if (task.status !== "pending") continue;
      if (task.dependsOn.every(done)) return task;
    }
    return null;
  }

  function remaining(): TaskNode[] {
    return graph.topologicalOrder().filter((t) => t.status !== "done");
  }

  function isComplete(): boolean {
    return remaining().length === 0;
  }

  function steps(): string[] {
    return graph.topologicalOrder().map((t) => t.title);
  }

  function serialize(): PlanStep[] {
    return graph.topologicalOrder().map((t) => ({
      title: t.title,
      status: t.status,
      dependsOn: t.dependsOn
    }));
  }

  return {
    graph,
    next,
    markRunning: (id) => graph.updateStatus(id, "running"),
    markDone: (id) => graph.updateStatus(id, "done"),
    markFailed: (id) => graph.updateStatus(id, "failed"),
    remaining,
    isComplete,
    steps,
    serialize
  };
}

/** CreateExecutionPlan inline type re-export for caller ergonomics. */
export type { TaskGraph, TaskInput, TaskNode } from "./TaskGraph";