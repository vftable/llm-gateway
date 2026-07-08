// Web-tool interception for Anthropic Messages requests.
//
// Anthropic's `web_search` / `web_fetch` are SERVER-SIDE (hosted) tools —
// Anthropic runs them and returns results inline. Most upstreams (e.g. 9router
// fronting arbitrary models) don't implement them. This module lets the gateway
// provide those tools itself, backed by a pluggable web provider (see
// ./web-providers):
//
//   1. detectWebTools()   — is the request asking for web_search / web_fetch?
//   2. rewriteRequest()   — swap the hosted tool DEFINITIONS for ordinary
//                           custom function tools the model can actually call
//                           (a normal `tool_use` block), so any model works.
//   3. executeWebTool()   — run a model's tool_use via the web provider and
//                           format the `tool_result` content for the loop.
//
// Everything here works in Anthropic Messages shape; the loop (web-tool-loop.ts)
// drives it. When the provider errors we return an error tool_result rather than
// failing the request, so the model can recover gracefully.

import type { SearchProvider } from "./web-providers";

export const WEB_SEARCH = "web_search";
export const WEB_FETCH = "web_fetch";

export interface WebToolsPresent {
  search: boolean;
  fetch: boolean;
}

// True when a tool definition is Anthropic's hosted web_search / web_fetch.
// Matches by the versioned `type` prefix ("web_search_20250305") or bare name.
function isHostedWebTool(
  t: Record<string, unknown>,
): "search" | "fetch" | null {
  const type = typeof t.type === "string" ? t.type : "";
  const name = typeof t.name === "string" ? t.name : "";
  if (type.startsWith("web_search") || name === WEB_SEARCH) return "search";
  if (type.startsWith("web_fetch") || name === WEB_FETCH) return "fetch";
  return null;
}

// Scan a Messages request body for hosted web tools.
export function detectWebTools(body: Record<string, unknown>): WebToolsPresent {
  const out: WebToolsPresent = { search: false, fetch: false };
  const tools = body.tools;
  if (!Array.isArray(tools)) return out;
  for (const tRaw of tools) {
    if (!tRaw || typeof tRaw !== "object") continue;
    const kind = isHostedWebTool(tRaw as Record<string, unknown>);
    if (kind === "search") out.search = true;
    if (kind === "fetch") out.fetch = true;
  }
  return out;
}

// True when EVERY tool in the request is a hosted web tool. This is the
// signature of a standalone web-search sub-request (Claude Code sends web
// search as its own /v1/messages call with only web_search tool(s)), which we
// can short-circuit — run the search directly and return a synthetic response
// without a model round-trip. Mirrors LiteLLM's try_short_circuit_search.
export function isWebToolsOnly(body: Record<string, unknown>): boolean {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.every(
    (t) =>
      t &&
      typeof t === "object" &&
      isHostedWebTool(t as Record<string, unknown>) !== null,
  );
}

// Extract the query for a short-circuit search: the last consecutive block of
// user messages, flattened to text. Mirrors LiteLLM's get_last_user_message.
export function getLastUserQuery(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";
  const tail: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (!m || typeof m !== "object" || m.role !== "user") break;
    tail.unshift(contentToText(m.content));
  }
  return tail.join("\n").trim();
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const bb = (b ?? {}) as Record<string, unknown>;
      return typeof bb.text === "string" ? bb.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

// Custom function-tool definitions the model calls with a normal tool_use.
const SEARCH_DEF = {
  name: WEB_SEARCH,
  description:
    "Search the web for current information. Returns a list of results with " +
    "titles, URLs and short descriptions. Use it when you need up-to-date or " +
    "external facts.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
    },
    required: ["query"],
  },
};

const FETCH_DEF = {
  name: WEB_FETCH,
  description:
    "Fetch the readable text content of a web page by URL, as markdown. Use it " +
    "to read a specific page (e.g. one returned by web_search).",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute URL to fetch." },
    },
    required: ["url"],
  },
};

// Replace hosted web tool defs with the custom function equivalents, leaving any
// other (client-provided) tools untouched. Also forces stream off for the loop.
// Returns a NEW body; the input is not mutated.
export function rewriteRequest(
  body: Record<string, unknown>,
  present: WebToolsPresent,
): Record<string, unknown> {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const kept: unknown[] = [];
  for (const tRaw of tools) {
    if (tRaw && typeof tRaw === "object") {
      const kind = isHostedWebTool(tRaw as Record<string, unknown>);
      if (kind) continue; // drop hosted defs; replaced below
    }
    kept.push(tRaw);
  }
  if (present.search) kept.push(SEARCH_DEF);
  if (present.fetch) kept.push(FETCH_DEF);

  const out: Record<string, unknown> = { ...body, tools: kept };
  delete out.stream; // the loop runs non-streaming internally
  return out;
}

// Is this tool_use name one the gateway handles server-side?
export function isWebToolName(name: unknown): boolean {
  return name === WEB_SEARCH || name === WEB_FETCH;
}

// One structured search hit in Anthropic's `web_search_result` shape.
interface WebSearchResultItem {
  type: "web_search_result";
  title: string;
  url: string;
  page_age: string;
  encrypted_content: string;
}

// Outcome of executing one web tool. `text` is fed back to the upstream model
// (which reasons over it); `results` / `error` drive the client-facing
// Anthropic web_search_tool_result block.
interface WebToolOutcome {
  // Text form for the model's tool message (OpenAI role:"tool" content).
  text: string;
  // Structured web_search_result items (search only) for the client block.
  results?: WebSearchResultItem[];
  // Error string when the tool failed (client block becomes an error result).
  error?: string;
}

// `encrypted_content` is Anthropic's opaque per-result payload that native
// clients pass back on multi-turn calls. We aren't Anthropic, so we emit an
// empty string here — matching how LiteLLM's web_search_tool_result block does
// it (the field is present but empty).
const SYNTHETIC = "";

// Execute one web tool call via the configured web provider. Never throws —
// failures become an error outcome the model can read and the client sees as an
// error result.
export async function executeWebTool(
  provider: SearchProvider,
  name: string,
  input: Record<string, unknown>,
): Promise<WebToolOutcome> {
  try {
    if (name === WEB_SEARCH) {
      const query = String(input.query ?? "").trim();
      if (!query)
        return {
          text: "Error: web_search requires a non-empty 'query'.",
          error: "invalid_input",
        };
      const hits = await provider.search(query, { limit: 5 });
      if (!hits.length)
        return {
          text: `No web results found for query: ${query}`,
          results: [],
        };

      const results: WebSearchResultItem[] = hits.map((r) => ({
        type: "web_search_result",
        title: r.title,
        url: r.url,
        page_age: "",
        encrypted_content: SYNTHETIC,
      }));
      // Text form for the reasoning model — explicit header so upstreams that
      // re-wrap tool messages still make it obvious these are live results.
      const list = hits
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.description || "(no description)"}`,
        )
        .join("\n\n");
      return { text: `Web search results for "${query}":\n\n${list}`, results };
    }

    if (name === WEB_FETCH) {
      const url = String(input.url ?? "").trim();
      if (!url)
        return {
          text: "Error: web_fetch requires a non-empty 'url'.",
          error: "invalid_input",
        };
      if (!provider.fetch)
        return {
          text: `web_fetch is not supported by the '${provider.name}' provider.`,
          error: "unsupported",
        };
      const page = await provider.fetch(url);
      const body = page.markdown || "(no readable content)";
      const capped =
        body.length > 20_000
          ? `${body.slice(0, 20_000)}\n\n…[content truncated]`
          : body;
      // web_fetch has no standard multi-result block; represent the fetched
      // page as a single web_search_result-style item + the full text.
      return {
        text: `# ${page.title}\n${page.url}\n\n${capped}`,
        results: [
          {
            type: "web_search_result",
            title: page.title,
            url: page.url,
            page_age: "",
            encrypted_content: SYNTHETIC,
          },
        ],
      };
    }
    return {
      text: `Error: unknown web tool '${name}'.`,
      error: "unknown_tool",
    };
  } catch (err) {
    const msg = (err as Error).message;
    return { text: `Error running ${name}: ${msg}`, error: msg };
  }
}
