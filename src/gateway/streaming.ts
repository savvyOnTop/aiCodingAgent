import type { FastifyReply, FastifyRequest } from "fastify";
import type { SseEvent } from "@ai-coding-agent/types";

export interface SseStream {
  send(event: SseEvent): void;
  close(): void;
  readonly aborted: Promise<void>;
  /** Events dropped under backpressure (text deltas only); for observability. */
  readonly dropped: number;
}

export interface SseStreamOptions {
  /** Max events buffered while the client socket is saturated. */
  maxBufferedEvents?: number;
}

const DEFAULT_MAX_BUFFERED = 500;

/** Terminal/interactive events must never be dropped under backpressure. */
const DROPPABLE = new Set<SseEvent["type"]>(["agent.text_delta", "agent.thought"]);

/**
 * Server-Sent Events response helper. The client connects via POST and reads
 * `data: <json>\n\n` frames from the response body.
 *
 * Backpressure (phase 10): when the socket write buffer is full, events queue
 * up to a watermark instead of growing unboundedly; beyond it, droppable
 * events (text deltas, thoughts) are shed oldest-first while control events
 * (tool calls, confirmations, done, errors) are always retained. The queue
 * flushes on the socket's drain event.
 */
export function createSseStream(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SseStreamOptions = {}
): SseStream {
  const maxBuffered = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED;
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  reply.raw.flushHeaders?.();
  reply.hijack();

  let abortedResolve: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    abortedResolve = resolve;
  });
  request.raw.on("close", () => {
    abortedResolve();
  });

  const queue: SseEvent[] = [];
  let saturated = false;
  let dropped = 0;

  function writable(): boolean {
    return !reply.raw.destroyed && !reply.raw.writableEnded;
  }

  function writeFrame(event: SseEvent): boolean {
    return reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  function flushQueue(): void {
    saturated = false;
    while (queue.length > 0 && writable()) {
      const next = queue.shift()!;
      if (!writeFrame(next)) {
        saturated = true;
        return;
      }
    }
  }

  reply.raw.on("drain", flushQueue);

  const stream: SseStream = {
    send(event: SseEvent) {
      if (!writable()) return;
      if (saturated) {
        queue.push(event);
        // shed oldest droppable events beyond the watermark; keep control events
        while (queue.length > maxBuffered) {
          const index = queue.findIndex((e) => DROPPABLE.has(e.type));
          if (index === -1) break; // only control events left: keep them all
          queue.splice(index, 1);
          dropped++;
        }
        return;
      }
      if (!writeFrame(event)) saturated = true;
    },
    close() {
      flushQueue();
      if (writable()) reply.raw.end();
    },
    aborted,
    get dropped() {
      return dropped;
    }
  };
  return stream;
}
