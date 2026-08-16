import type { Tool, ToolContext, ToolResult } from "@ai-coding-agent/types";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_CHARS = 200_000;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_CRAWL_PAGES = 8;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " "
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** Minimal HTML → markdown conversion: headings, links, lists, code, emphasis. */
export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "");

  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, body: string) => {
    const code = decodeEntities(body.replace(/<[^>]+>/g, ""));
    return `\n\`\`\`\n${code.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n`;
  });

  text = text
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, body: string) => {
      return `\n${"#".repeat(Number(level))} ${body.replace(/<[^>]+>/g, "").trim()}\n`;
    })
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, body: string) => {
      const label = body.replace(/<[^>]+>/g, "").trim();
      return label ? `[${label}](${href})` : href;
    })
    .replace(/<img\s[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, alt: string) => (alt ? `![${alt}]` : ""))
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<[^>]+>/g, "");

  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extracts elements matching a simple selector: `tag`, `#id`, `.class`, `tag.class`, `tag#id`. */
export function extractBySelector(html: string, selector: string): string[] {
  const parsed = /^([a-zA-Z][a-zA-Z0-9]*)?(?:([#.])([\w-]+))?$/.exec(selector.trim());
  if (!parsed || (!parsed[1] && !parsed[3])) return [];
  const tag = parsed[1] ?? "[a-zA-Z][a-zA-Z0-9]*";
  const attr = parsed[2] === "#" ? "id" : parsed[2] === "." ? "class" : undefined;
  const value = parsed[3];
  const attrPattern = attr ? `[^>]*\\b${attr}=["'][^"']*\\b${value}\\b[^"']*["']` : "";
  const re = new RegExp(`<(${tag})${attrPattern}[^>]*>([\\s\\S]*?)<\\/\\1>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const text = htmlToMarkdown(match[2]!);
    if (text) out.push(text);
    if (out.length >= 20) break;
  }
  return out;
}

/** Fetches a page with a timeout and size cap. No env-derived headers are ever sent. */
async function fetchPage(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "ai-coding-agent-browser/0.1", accept: "text/html,text/plain,*/*" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.text();
  return body.slice(0, MAX_PAGE_CHARS);
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  const base = new URL(baseUrl);
  const re = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1]!, baseUrl);
      if (resolved.origin === base.origin) links.add(resolved.toString());
    } catch {
      // unparseable href: skip
    }
  }
  return [...links];
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + "\n[truncated]" : text;
}

const browserOpen: Tool = {
  name: "browser_open",
  description:
    "Fetch a web page and return it as markdown (headings, links, lists, code). Pass raw=true for the raw HTML. Secrets are redacted; no credentials are ever sent.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL to open" },
      raw: { type: "boolean", description: "Return raw HTML instead of markdown" }
    },
    required: ["url"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const html = await fetchPage(String(input.url ?? ""));
      const body = input.raw === true ? html : htmlToMarkdown(html);
      return { status: "success", output: ctx.redact(cap(body)) };
    } catch (err) {
      return { status: "error", output: err instanceof Error ? err.message : String(err) };
    }
  }
};

const browserExtract: Tool = {
  name: "browser_extract",
  description:
    "Fetch a web page and extract the elements matching a simple CSS selector (tag, #id, .class, tag.class). Returns their markdown text.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL to open" },
      selector: { type: "string", description: "Selector, e.g. \"h1\", \"#main\", \".article\"" }
    },
    required: ["url", "selector"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const html = await fetchPage(String(input.url ?? ""));
      const hits = extractBySelector(html, String(input.selector ?? ""));
      if (hits.length === 0) return { status: "success", output: "(no elements matched)" };
      return { status: "success", output: ctx.redact(cap(hits.join("\n\n---\n\n"))) };
    } catch (err) {
      return { status: "error", output: err instanceof Error ? err.message : String(err) };
    }
  }
};

const browserCrawl: Tool = {
  name: "browser_crawl",
  description:
    "Crawl same-origin links from a starting page (breadth-first, up to depth 2, max 8 pages) and return each page as capped markdown.",
  requiresConfirmation: false,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL to start from" },
      maxDepth: { type: "number", description: "Link depth to follow (default 1, max 2)" }
    },
    required: ["url"]
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const start = String(input.url ?? "");
    const maxDepth = Math.min(Number(input.maxDepth ?? 1), 2);
    const visited = new Set<string>([start]);
    const sections: string[] = [];
    let frontier = [start];
    try {
      for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const url of frontier) {
          if (visited.size > MAX_CRAWL_PAGES) break;
          let html: string;
          try {
            html = await fetchPage(url);
          } catch (err) {
            sections.push(`## ${url}\n(fetch failed: ${err instanceof Error ? err.message : String(err)})`);
            continue;
          }
          sections.push(`## ${url}\n${htmlToMarkdown(html).slice(0, 2000)}`);
          if (depth < maxDepth) {
            for (const link of extractLinks(html, url)) {
              if (!visited.has(link) && visited.size <= MAX_CRAWL_PAGES) {
                visited.add(link);
                next.push(link);
              }
            }
          }
        }
        frontier = next;
      }
      return { status: "success", output: ctx.redact(cap(sections.join("\n\n"))) };
    } catch (err) {
      return { status: "error", output: err instanceof Error ? err.message : String(err) };
    }
  }
};

export const browserTools: Tool[] = [browserOpen, browserExtract, browserCrawl];
