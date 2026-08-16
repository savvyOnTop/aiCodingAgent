import { createServer, type Server } from "http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "@ai-coding-agent/types";
import { browserTools, extractBySelector, htmlToMarkdown } from "./BrowserTool";

const PAGES: Record<string, string> = {
  "/": `<html><head><title>Home</title><script>var x=1;</script></head>
<body>
  <h1>Fixture Site</h1>
  <p>Welcome to the <strong>fixture</strong> server. TOKEN_VALUE_XYZ</p>
  <ul><li>alpha</li><li>beta</li></ul>
  <a href="/docs">Read the docs</a>
  <pre>const a = 1 &amp;&amp; 2;</pre>
  <div id="main">central content</div>
  <span class="note">a note</span>
</body></html>`,
  "/docs": `<html><body><h2>Docs</h2><p>documentation body</p><a href="/deep">deeper</a></body></html>`,
  "/deep": `<html><body><h3>Deep</h3><p>bottom page</p></body></html>`
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[req.url ?? "/"];
    if (!body) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const ctx: ToolContext = {
  workspace: {} as ToolContext["workspace"],
  sessionId: "s",
  cwd: ".",
  redact: (t) => t.split("TOKEN_VALUE_XYZ").join("***")
};

function tool(name: string) {
  return browserTools.find((t) => t.name === name)!;
}

describe("htmlToMarkdown", () => {
  it("converts headings, links, lists, emphasis, and code", () => {
    const md = htmlToMarkdown(PAGES["/"]!);
    expect(md).toContain("# Fixture Site");
    expect(md).toContain("**fixture**");
    expect(md).toContain("- alpha");
    expect(md).toContain("[Read the docs](/docs)");
    expect(md).toContain("```\nconst a = 1 && 2;\n```");
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("var x=1");
  });
});

describe("extractBySelector", () => {
  it("supports tag, #id, and .class selectors", () => {
    expect(extractBySelector(PAGES["/"]!, "h1")).toEqual(["Fixture Site"]);
    expect(extractBySelector(PAGES["/"]!, "#main")).toEqual(["central content"]);
    expect(extractBySelector(PAGES["/"]!, ".note")).toEqual(["a note"]);
    expect(extractBySelector(PAGES["/"]!, "#missing")).toEqual([]);
  });
});

describe("browser tools", () => {
  it("browser_open returns redacted markdown", async () => {
    const res = await tool("browser_open").execute({ url: `${baseUrl}/` }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("# Fixture Site");
    expect(res.output).toContain("***");
    expect(res.output).not.toContain("TOKEN_VALUE_XYZ");
  });

  it("browser_open rejects non-http protocols", async () => {
    const res = await tool("browser_open").execute({ url: "file:///etc/passwd" }, ctx);
    expect(res.status).toBe("error");
    expect(res.output).toContain("Unsupported protocol");
  });

  it("browser_extract pulls selector content", async () => {
    const res = await tool("browser_extract").execute({ url: `${baseUrl}/`, selector: "#main" }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toBe("central content");
  });

  it("browser_crawl follows same-origin links to maxDepth", async () => {
    const res = await tool("browser_crawl").execute({ url: `${baseUrl}/`, maxDepth: 1 }, ctx);
    expect(res.status).toBe("success");
    expect(res.output).toContain("# Fixture Site");
    expect(res.output).toContain("## Docs");
    expect(res.output).not.toContain("bottom page"); // depth 2 not reached
  });
});
