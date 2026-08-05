import { spawn, type ChildProcess } from "child_process";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage, Server } from "http";
import * as pty from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";
import type { ConversationService } from "../conversation";

export interface TerminalOptions {
  conversations: ConversationService;
  /** Expected token; defaults to process.env.AUTH_TOKEN. */
  token?: string;
}

interface TerminalProc {
  write(data: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (code?: number) => void): void;
  kill(): void;
}

interface TerminalSession {
  ws: WebSocket;
  proc: TerminalProc;
}

function fromNodePty(process_: pty.IPty): TerminalProc {
  return {
    write: (data) => process_.write(data),
    onData: (cb) => process_.onData(cb),
    onExit: (cb) => process_.onExit(({ exitCode }) => cb(exitCode)),
    kill: () => process_.kill()
  };
}

function fromChildProcess(child: ChildProcess): TerminalProc {
  return {
    write: (data) => {
      if (child.stdin?.writable) child.stdin.write(data);
    },
    onData: (cb) => {
      child.stdout?.on("data", (chunk: Buffer) => cb(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => cb(chunk.toString("utf8")));
    },
    onExit: (cb) => child.on("exit", (code) => cb(code ?? undefined)),
    kill: () => child.kill()
  };
}

/**
 * Live terminal over WebSocket (the one bidirectional channel; everything
 * else uses SSE). Connect to:
 *   ws://host/api/sessions/:id/terminal?token=<auth>
 *
 * Local workspaces get a real PTY via node-pty; docker workspaces shell into
 * the session container with `docker exec -it`.
 */
export function registerTerminal(app: FastifyInstance, options: TerminalOptions): void {
  const expected = options.token ?? process.env.AUTH_TOKEN ?? "dev-token";
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, TerminalSession>();

  const server: Server = app.server;
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/terminal$/);
    if (!match) return;
    if (url.searchParams.get("token") !== expected) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(ws, match[1]!);
    });
  });

  app.addHook("onClose", () => {
    for (const session of sessions.values()) {
      session.proc.kill();
      session.ws.close();
    }
    sessions.clear();
    wss.close();
  });

  function handleConnection(ws: WebSocket, conversationId: string): void {
    let proc: TerminalProc;
    try {
      proc = spawnShell(options.conversations.getWorkspace(conversationId));
    } catch (err) {
      ws.send(`\r\n[terminal] ${err instanceof Error ? err.message : String(err)}\r\n`);
      ws.close();
      return;
    }

    sessions.set(conversationId, { ws, proc });
    proc.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    proc.onExit((code) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n[shell exited with code ${code ?? "?"}]\r\n`);
        ws.close();
      }
      sessions.delete(conversationId);
    });

    ws.on("message", (data) => {
      const raw = data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : String(data);
      try {
        const parsed = JSON.parse(raw) as { type?: string; cols?: number; rows?: number };
        if (parsed.type === "resize" && parsed.cols && parsed.rows && "resize" in proc) {
          (proc as { resize(c: number, r: number): void }).resize(parsed.cols, parsed.rows);
          return;
        }
      } catch {
        // not JSON → raw keystrokes
      }
      proc.write(raw);
    });
    ws.on("close", () => {
      proc.kill();
      sessions.delete(conversationId);
    });
  }
}

function spawnShell(workspace: { kind: string; rootPath?: string; containerName?: string }): TerminalProc {
  if (workspace.kind === "docker") {
    return fromChildProcess(
      spawn("docker", ["exec", "-it", workspace.containerName ?? "", "sh"], {
        cwd: workspace.rootPath
      })
    );
  }
  if (workspace.kind === "local") {
    return fromNodePty(
      pty.spawn("bash", ["--noprofile", "--norc"], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: workspace.rootPath ?? process.cwd(),
        env: process.env as Record<string, string>
      })
    );
  }
  throw new Error(`no terminal backend for workspace kind "${workspace.kind}"`);
}
