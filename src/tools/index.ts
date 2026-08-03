import type { Tool } from "@ai-coding-agent/types";
import { fileTools } from "./FileTool";
import { gitTools } from "./GitTool";
import { terminalTool } from "./TerminalTool";
import { searchTool } from "./SearchTool";
import { diagnosticsTool } from "./DiagnosticsTool";

export const defaultTools: Tool[] = [
  ...fileTools,
  ...gitTools,
  terminalTool,
  searchTool,
  diagnosticsTool
];

export { fileTools } from "./FileTool";
export { gitTools } from "./GitTool";
export { terminalTool } from "./TerminalTool";
export { searchTool } from "./SearchTool";
export { diagnosticsTool } from "./DiagnosticsTool";
