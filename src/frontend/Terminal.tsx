import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

const AUTH_TOKEN = (import.meta.env.VITE_AUTH_TOKEN as string | undefined) ?? "dev-token";

/**
 * Live workspace terminal: xterm.js over WebSocket
 * (ws://host/api/sessions/:id/terminal?token=...).
 */
export function TerminalPanel({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Xterm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, monospace",
      theme: { background: "#0d1017" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/sessions/${sessionId}/terminal?token=${encodeURIComponent(AUTH_TOKEN)}`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      term.write("\r\n[terminal connected]\r\n");
      term.focus();
    };
    ws.onmessage = (event) => {
      term.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
    };
    ws.onclose = () => {
      term.write("\r\n[terminal disconnected]\r\n");
    };
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [sessionId]);

  return <div className="terminal" ref={containerRef} />;
}
