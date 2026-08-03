import type { SseEvent } from "@ai-coding-agent/types";
import { useState } from "react";
import { confirmTool, streamMessage } from "./api";

interface UiBlock {
  id: string;
  kind: "user" | "assistant" | "tool" | "confirm" | "error" | "done";
  content: string;
  callId?: string;
  tool?: string;
  input?: Record<string, unknown>;
  status?: string;
  usage?: SseEvent & { type: "agent.done" };
}

function usageText(usage: UiBlock["usage"]): string {
  if (!usage?.usage) return "";
  return ` · in ${usage.usage.inputTokens} / out ${usage.usage.outputTokens} tok (${usage.usage.provider}/${usage.usage.model})`;
}

function applyEvent(blocks: UiBlock[], event: SseEvent): UiBlock[] {
  switch (event.type) {
    case "agent.text_delta": {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "assistant") {
        return blocks.map((b, i) => (i === blocks.length - 1 ? { ...b, content: b.content + event.delta } : b));
      }
      return [...blocks, { id: crypto.randomUUID(), kind: "assistant", content: event.delta }];
    }
    case "agent.tool_start":
      return [
        ...blocks,
        {
          id: crypto.randomUUID(),
          kind: "tool",
          content: "",
          callId: event.callId,
          tool: event.tool,
          input: event.input,
          status: "running"
        }
      ];
    case "agent.tool_result":
      return blocks.map((b) =>
        b.callId === event.callId && b.kind === "tool"
          ? { ...b, status: event.status, content: event.output }
          : b
      );
    case "agent.confirm_request":
      return [...blocks, { id: crypto.randomUUID(), kind: "confirm", content: "", callId: event.callId, tool: event.tool, input: event.input }];
    case "agent.done":
      return [
        ...blocks,
        { id: crypto.randomUUID(), kind: "done", content: event.summary, usage: event }
      ];
    case "agent.error":
      return [...blocks, { id: crypto.randomUUID(), kind: "error", content: event.message }];
    default:
      return blocks;
  }
}

export function ChatPanel({ sessionId }: { sessionId: string }) {
  const [blocks, setBlocks] = useState<UiBlock[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);

  async function send() {
    const content = input.trim();
    if (!content || running) return;
    setInput("");
    setBlocks((b) => [...b, { id: crypto.randomUUID(), kind: "user", content }]);
    setRunning(true);
    const controller = new AbortController();
    try {
      await streamMessage(sessionId, content, (event) => setBlocks((b) => applyEvent(b, event)), controller.signal);
    } catch (err) {
      setBlocks((b) => [
        ...b,
        { id: crypto.randomUUID(), kind: "error", content: err instanceof Error ? err.message : String(err) }
      ]);
    } finally {
      setRunning(false);
    }
  }

  async function respond(callId: string, approved: boolean) {
    await confirmTool(sessionId, callId, approved);
    setBlocks((b) =>
      b.map((block) =>
        block.kind === "confirm" && block.callId === callId
          ? { ...block, kind: "tool", status: approved ? "running" : "error", content: approved ? "approved" : "denied" }
          : block
      )
    );
  }

  return (
    <section className="chat">
      <div className="chat-messages">
        {blocks.length === 0 && <p className="hint">Describe a task, e.g. "fix the failing test".</p>}
        {blocks.map((b) => <BlockView key={b.id} block={b} onRespond={respond} />)}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the agent to change something…"
          disabled={running}
        />
        <button type="submit" disabled={running || !input.trim()}>
          {running ? "Working…" : "Send"}
        </button>
      </form>
    </section>
  );
}

function BlockView({
  block,
  onRespond
}: {
  block: UiBlock;
  onRespond: (callId: string, approved: boolean) => void;
}) {
  if (block.kind === "user") return <div className="msg user">{block.content}</div>;
  if (block.kind === "assistant") return <div className="msg assistant">{block.content || "…"}</div>;
  if (block.kind === "error") return <div className="msg error">{block.content}</div>;
  if (block.kind === "done") return <div className="msg done">✓ {block.content || "Done."}{usageText(block.usage)}</div>;
  if (block.kind === "confirm") {
    return (
      <div className="msg confirm">
        <strong>Confirm: {block.tool}</strong>
        <pre>{JSON.stringify(block.input, null, 2)}</pre>
        <div className="confirm-actions">
          <button onClick={() => onRespond(block.callId!, true)}>Approve</button>
          <button onClick={() => onRespond(block.callId!, false)}>Deny</button>
        </div>
      </div>
    );
  }
  return (
    <div className={`msg tool ${block.status ?? ""}`}>
      <strong>⛏ {block.tool}</strong>
      {block.content ? <pre>{block.content}</pre> : <span className="spinner">working…</span>}
    </div>
  );
}
