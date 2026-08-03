import type { FastifyReply, FastifyRequest } from "fastify";
import type { SseEvent } from "@ai-coding-agent/types";

export interface SseStream {
  send(event: SseEvent): void;
  close(): void;
  readonly aborted: Promise<void>;
}

/**
 * Server-Sent Events response helper. The client connects via POST and reads
 * `data: <json>\n\n` frames from the response body.
 */
export function createSseStream(request: FastifyRequest, reply: FastifyReply): SseStream {
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

  const stream: SseStream = {
    send(event: SseEvent) {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    },
    aborted
  };
  return stream;
}
