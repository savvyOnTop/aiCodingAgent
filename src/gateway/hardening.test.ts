import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ConversationRecord, SseEvent } from "@ai-coding-agent/types";
import type { ConversationService } from "../conversation";
import { buildServer } from "./index";
import { createRateLimiter } from "./rateLimit";
import { createSessionRegistry } from "./session";
import { createSseStream, type SseStream } from "./streaming";

const fakeConversations = {
  create: async (): Promise<ConversationRecord> => ({
    id: "conv-1",
    workspaceId: "ws-1",
    createdAt: 0,
    branchId: "main",
    parentId: null
  }),
  list: () => [],
  history: () => [],
  confirm: () => true,
  terminate: () => {},
  destroy: async () => {}
} as unknown as ConversationService;

describe("auth (401 path)", () => {
  it("returns the standardized error body", async () => {
    const app = await buildServer({ authToken: "secret", conversations: fakeConversations, sessions: createSessionRegistry() });
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "unauthorized", retriable: false });
    await app.close();
  });
});

describe("rate limiting (429 path)", () => {
  it("caps requests per token inside the window", async () => {
    const app = await buildServer({
      authToken: "secret",
      conversations: fakeConversations,
      sessions: createSessionRegistry(),
      rateLimit: { max: 2, windowMs: 60_000 }
    });
    const call = () =>
      app.inject({ method: "GET", url: "/api/sessions", headers: { authorization: "Bearer secret" } });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);
    const third = await call();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ code: "rate_limited", retriable: true });
    await app.close();
  });

  it("fixed window resets and keys are independent", () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(limiter.allow("a")).toBe(true);
    vi.useRealTimers();
  });
});

describe("session registry fan-out caps", () => {
  function fakeStream(): SseStream & { closed: boolean } {
    const stream = {
      closed: false,
      send: () => {},
      close() {
        stream.closed = true;
      },
      aborted: new Promise<void>(() => {}),
      dropped: 0
    };
    return stream;
  }

  it("closes the previous stream when a conversation reconnects", () => {
    const registry = createSessionRegistry();
    const first = fakeStream();
    const second = fakeStream();
    registry.attach("c1", first);
    registry.attach("c1", second);
    expect(first.closed).toBe(true);
    expect(registry.get("c1")).toBe(second);
    expect(registry.size()).toBe(1);
  });

  it("rejects new streams beyond the global cap", () => {
    const registry = createSessionRegistry({ maxStreams: 1 });
    registry.attach("c1", fakeStream());
    expect(() => registry.attach("c2", fakeStream())).toThrow(/Too many concurrent streams/);
  });
});

describe("SSE backpressure", () => {
  function fakeHttp(writeReturns: boolean) {
    const written: string[] = [];
    const listeners = new Map<string, () => void>();
    const raw = {
      destroyed: false,
      writableEnded: false,
      writeHead: () => raw,
      flushHeaders: () => {},
      write: vi.fn((frame: string) => {
        written.push(frame);
        return writeReturns;
      }),
      end: () => {
        raw.writableEnded = true;
      },
      on: (event: string, cb: () => void) => {
        listeners.set(event, cb);
      }
    };
    const reply = { raw, hijack: () => {} } as unknown as FastifyReply;
    const request = { raw: { on: () => {} } } as unknown as FastifyRequest;
    return { reply, request, written, drain: () => listeners.get("drain")?.() };
  }

  const delta = (i: number): SseEvent => ({ type: "agent.text_delta", delta: `d${i}` });

  it("bounds the buffer under backpressure and sheds only droppable events", () => {
    const { reply, request } = fakeHttp(false); // socket always saturated
    const stream = createSseStream(request, reply, { maxBufferedEvents: 10 });
    stream.send(delta(0)); // first write saturates
    for (let i = 1; i <= 50; i++) stream.send(delta(i));
    stream.send({ type: "agent.done", summary: "s", usage: null });
    expect(stream.dropped).toBeGreaterThan(0);
    // 50 queued deltas - 10 kept, then agent.done displaces one more delta
    expect(stream.dropped).toBe(41);
  });

  it("flushes the queue on drain and never drops control events", () => {
    const { reply, request, written, drain } = fakeHttp(false);
    const stream = createSseStream(request, reply, { maxBufferedEvents: 2 });
    stream.send(delta(0));
    for (let i = 1; i <= 5; i++) stream.send(delta(i));
    stream.send({ type: "agent.done", summary: "end", usage: null });
    // drain with a now-writable socket
    (reply.raw.write as ReturnType<typeof vi.fn>).mockImplementation((frame: string) => {
      written.push(frame);
      return true;
    });
    drain();
    expect(written.some((f) => f.includes("agent.done"))).toBe(true);
  });
});
