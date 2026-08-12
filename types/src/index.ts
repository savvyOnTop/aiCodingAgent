/**
 * Shared contracts consumed by every layer (server + frontend).
 * Layer files must only depend on this package and their own layer.
 */

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
  /** Present on assistant messages that issued tool calls. */
  toolCalls?: ToolCall[];
  /** Present on tool-role messages; links to the originating assistant call. */
  toolCallId?: string;
}

export interface ModelToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelCallResult {
  text: string | null;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    provider: string;
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolResultStatus = "success" | "error" | "needs_confirmation";

export interface ToolResult {
  status: ToolResultStatus;
  output: string;
  truncated?: boolean;
}

export interface ToolContext {
  workspace: Workspace;
  sessionId: string;
  /** Directory relative to the workspace root that commands run in. */
  cwd: string;
  redact(text: string): string;
}

export interface Tool {
  name: string;
  description: string;
  requiresConfirmation: boolean;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

export interface GitStatusResult {
  branch: string;
  modified: string[];
  untracked: string[];
}

export interface Workspace {
  readonly id: string;
  readonly kind: "local" | "docker" | "firecracker";
  /** Absolute path where the workspace files live (host for local, container mount for docker). */
  readonly rootPath?: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<FileEntry[]>;
  runCommand(command: string, cwd?: string): Promise<CommandResult>;
  gitStatus(): Promise<GitStatusResult>;
  gitDiff(path?: string): Promise<string>;
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SSE events (gateway -> frontend)
// ---------------------------------------------------------------------------

export type SseEvent =
  | { type: "agent.text_delta"; delta: string }
  | { type: "agent.thought"; thought: string }
  | { type: "agent.plan"; steps: string[] }
  | { type: "agent.tool_start"; callId: string; tool: string; input: Record<string, unknown> }
  | { type: "agent.tool_result"; callId: string; status: ToolResultStatus; output: string }
  | { type: "agent.confirm_request"; callId: string; tool: string; input: Record<string, unknown> }
  | { type: "agent.validation"; checker: string; status: "passed" | "failed"; output: string }
  | { type: "agent.done"; summary: string; usage: ModelCallResult["usage"] | null }
  | { type: "agent.error"; message: string };

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  createdAt: number;
  branchId: string;
  parentId: string | null;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  toolCalls: ToolCall[];
  createdAt: number;
}
