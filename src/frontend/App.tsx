import { useEffect, useState } from "react";
import { createSession } from "./api";
import { ChatPanel } from "./ChatPanel";
import { FileExplorer } from "./FileExplorer";
import "./styles.css";

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);

  async function newSession() {
    setBusy(true);
    try {
      const { sessionId } = await createSession(root.trim() || undefined);
      setSessionId(sessionId);
      setRoot("");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!sessionId) void newSession();
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>AI Coding Agent</h1>
        <form
          className="session-form"
          onSubmit={(e) => {
            e.preventDefault();
            void newSession();
          }}
        >
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="Workspace path (default: temp scratch dir)"
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            New session
          </button>
        </form>
        {sessionId && <span className="session-id">session {sessionId.slice(0, 8)}</span>}
      </header>
      {sessionId ? (
        <main className="app-body">
          <FileExplorer sessionId={sessionId} />
          <ChatPanel sessionId={sessionId} />
        </main>
      ) : (
        <p className="hint">Creating session…</p>
      )}
    </div>
  );
}
