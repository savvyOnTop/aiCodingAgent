import type { SseStream } from "./streaming";

export interface SessionRegistryOptions {
  /** Max concurrent SSE streams across all conversations (bounded fan-out). */
  maxStreams?: number;
}

export interface SessionRegistry {
  /**
   * Registers the stream for a conversation. One live stream per conversation:
   * an existing stream is closed first. Throws when the global cap is reached.
   */
  attach(conversationId: string, stream: SseStream): void;
  get(conversationId: string): SseStream | undefined;
  size(): number;
  close(conversationId: string): void;
  closeAll(): void;
}

const DEFAULT_MAX_STREAMS = 64;

/** Tracks active SSE streams per conversation so routes can close them. */
export function createSessionRegistry(options: SessionRegistryOptions = {}): SessionRegistry {
  const maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
  const streams = new Map<string, SseStream>();

  function attach(conversationId: string, stream: SseStream): void {
    const existing = streams.get(conversationId);
    if (existing) {
      existing.close();
      streams.delete(conversationId);
    }
    if (streams.size >= maxStreams) {
      throw new Error(`Too many concurrent streams (max ${maxStreams})`);
    }
    streams.set(conversationId, stream);
  }

  function get(conversationId: string): SseStream | undefined {
    return streams.get(conversationId);
  }

  function size(): number {
    return streams.size;
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

  return { attach, get, size, close, closeAll };
}
