import { describe, expect, it } from "vitest";
import { createTaskGraph } from "./TaskGraph";

describe("TaskGraph", () => {
  it("adds tasks with generated ids and reads them back", () => {
    const graph = createTaskGraph();
    const a = graph.addTask({ title: "Read files", description: "inspect" });
    const b = graph.addTask({ title: "Write code", description: "implement" });
    expect(a.id).toBe("t1");
    expect(b.id).toBe("t2");
    expect(graph.get("t1")?.title).toBe("Read files");
    expect(graph.nodes.size).toBe(2);
  });

  it("orders tasks so dependencies come first", () => {
    const graph = createTaskGraph();
    const a = graph.addTask({ title: "a", description: "" });
    const b = graph.addTask({ title: "b", description: "" });
    graph.addTask({ title: "c", description: "", dependsOn: [b.id, a.id] });
    const order = graph.topologicalOrder().map((t) => t.title);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("throws when a dependency references an unknown task", () => {
    const graph = createTaskGraph();
    expect(() => graph.addTask({ title: "x", description: "", dependsOn: ["nope"] })).toThrow(
      /unknown task/i
    );
  });

  it("detects cycles", () => {
    const graph = createTaskGraph();
    graph.addTask({ title: "a", description: "", dependsOn: [] });
    graph.addTask({ title: "b", description: "", dependsOn: ["t1"] });
    graph.updateStatus("t1", "pending");
    expect(graph.isCyclic()).toBe(false);
  });

  it("rejects a real cycle via topologicalOrder", () => {
    const graph = createTaskGraph();
    graph.addTask({ title: "a", description: "", dependsOn: [] });
    graph.addTask({ title: "b", description: "", dependsOn: ["t1"] });
    // mutate to add back-edge
    graph.nodes.get("t1")!.dependsOn.push("t2");
    expect(() => graph.topologicalOrder()).toThrow(/cycle/i);
    expect(graph.isCyclic()).toBe(true);
  });

  it("tracks status transitions", () => {
    const graph = createTaskGraph();
    const task = graph.addTask({ title: "a", description: "" });
    expect(task.status).toBe("pending");
    graph.updateStatus(task.id, "running");
    graph.updateStatus(task.id, "done");
    expect(graph.get(task.id)?.status).toBe("done");
    expect(() => graph.updateStatus("missing", "done")).toThrow(/unknown task/i);
  });
});