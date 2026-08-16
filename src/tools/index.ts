import type { Tool } from "@ai-coding-agent/types";
import { fileTools } from "./FileTool";
import { gitTools } from "./GitTool";
import { terminalTool } from "./TerminalTool";
import { searchTools } from "./SearchTool";
import { diagnosticsTools } from "./DiagnosticsTool";
import { browserTools } from "./BrowserTool";

export const defaultTools: Tool[] = [
  ...fileTools,
  ...gitTools,
  terminalTool,
  ...searchTools,
  ...diagnosticsTools,
  ...browserTools
];

export { fileTools } from "./FileTool";
export { gitTools } from "./GitTool";
export { terminalTool } from "./TerminalTool";
export { searchTool, searchTools, searchWorkspace, type SearchMatch, type SearchOptions } from "./SearchTool";
export {
  diagnosticsTool,
  diagnosticsTools,
  classifyFailure,
  type FailureDiagnosis,
  type FailureKind
} from "./DiagnosticsTool";
export { browserTools, htmlToMarkdown, extractBySelector } from "./BrowserTool";
