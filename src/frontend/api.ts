import type { SseEvent } from "@ai-coding-agent/types";

const AUTH_TOKEN = (import.meta.env.VITE_AUTH_TOKEN as string | undefined) ?? "dev-token";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function createSession(root?: string): Promise<{ sessionId: string }> {
  return request("/api/sessions", { method: "POST", body: JSON.stringify({ root }) });
}

export async function confirmTool(
  sessionId: string,
  callId: string,
  approved: boolean
): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${sessionId}/tools/${callId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ approved })
  });
}

export interface FileEntryDto {
  name: string;
  path: string;
  type: "file" | "dir";
}

export async function listFiles(sessionId: string, path = ""): Promise<{ entries: FileEntryDto[] }> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return request(`/api/sessions/${sessionId}/files${query}`);
}

export interface MessageDto {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

export async function getHistory(sessionId: string): Promise<{ messages: MessageDto[] }> {
  return request(`/api/sessions/${sessionId}/history`);
}

/** POST-based SSE: the server streams agent events in the response body. */
export async function streamMessage(
  sessionId: string,
  content: string,
  onEvent: (event: SseEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content }),
    signal
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          onEvent(JSON.parse(line.slice(6)) as SseEvent);
        }
      }
    }
  }
}
