export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Ids of tasks that must finish before this one starts. */
  dependsOn: string[];
}

export interface TaskInput {
  title: string;
  description: string;
  dependsOn?: string[];
}

export interface TaskGraph {
  /** Read-only view of all tasks keyed by id. */
  nodes: ReadonlyMap<string, TaskNode>;
  addTask(input: TaskInput): TaskNode;
  updateStatus(id: string, status: TaskStatus): void;
  get(id: string): TaskNode | undefined;
  /** Deterministic order (Kahn) that respects dependencies; throws on cycles. */
  topologicalOrder(): TaskNode[];
  isCyclic(): boolean;
}

/**
 * TaskGraph as a factory function: a minimal DAG of work items. Tasks are
 * identified by generated ids (t1, t2, ...) so the model can express
 * dependencies as 1-based step numbers and we never trust model-authored ids.
 */
export function createTaskGraph(): TaskGraph {
  const nodes = new Map<string, TaskNode>();
  const insertion = new Map<string, number>();
  let counter = 0;

  function addTask(input: TaskInput): TaskNode {
    for (const dep of input.dependsOn ?? []) {
      if (!nodes.has(dep)) throw new Error(`Task depends on unknown task: ${dep}`);
    }
    counter += 1;
    const id = `t${counter}`;
    const task: TaskNode = {
      id,
      title: input.title,
      description: input.description,
      status: "pending",
      dependsOn: [...new Set(input.dependsOn ?? [])]
    };
    nodes.set(id, task);
    insertion.set(id, counter);
    return task;
  }

  function updateStatus(id: string, status: TaskStatus): void {
    const task = nodes.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    task.status = status;
  }

  function get(id: string): TaskNode | undefined {
    return nodes.get(id);
  }

  /** Kahn's algorithm; ties broken by insertion order for determinism. */
  function topologicalOrder(): TaskNode[] {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const task of nodes.values()) {
      indegree.set(task.id, task.dependsOn.length);
      for (const dep of task.dependsOn) {
        const list = dependents.get(dep) ?? [];
        list.push(task.id);
        dependents.set(dep, list);
      }
    }
    const ready = [...nodes.values()]
      .filter((t) => indegree.get(t.id) === 0)
      .sort((a, b) => insertion.get(a.id)! - insertion.get(b.id)!);
    const result: TaskNode[] = [];
    while (ready.length > 0) {
      const task = ready.shift()!;
      result.push(task);
      for (const dependent of dependents.get(task.id) ?? []) {
        indegree.set(dependent, indegree.get(dependent)! - 1);
        if (indegree.get(dependent) === 0) {
          const next = nodes.get(dependent)!;
          const index = ready.findIndex((r) => insertion.get(r.id)! > insertion.get(next.id)!);
          ready.splice(index === -1 ? ready.length : index, 0, next);
        }
      }
    }
    if (result.length !== nodes.size) {
      throw new Error("Task graph contains a cycle");
    }
    return result;
  }

  function isCyclic(): boolean {
    try {
      topologicalOrder();
      return false;
    } catch {
      return true;
    }
  }

  return { nodes, addTask, updateStatus, get, topologicalOrder, isCyclic };
}
