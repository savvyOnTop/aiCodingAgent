import type { SseStream } from "./streaming";

export interface SessionRegistry {
  attach(conversationId: string, stream: SseStream): void;
  get(conversationId: string): SseStream | undefined;
  close(conversationId: string): void;
  closeAll(): void;
}

/** Tracks active SSE streams per conversation so routes can close them. */
export function createSessionRegistry(): SessionRegistry {
  const streams = new Map<string, SseStream>();

  function attach(conversationId: string, stream: SseStream): void {
    streams.set(conversationId, stream);
  }

  function get(conversationId: string): SseStream | undefined {
    return streams.get(conversationId);
  }

  function close(conversationId: string): void {
    const stream = streams.get(conversationId);
    if (stream) {
      stream.close();
      streams.delete(conversationId);
    }
  }

  function closeAll(): void {
    for (const id of [...streams.keys()]) close(id);
  }

  return { attach, get, close, closeAll };
}
