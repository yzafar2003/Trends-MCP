#!/usr/bin/env node
// MCP server for Google Trends. Runs over stdio so Claude Code / Cursor can
// spawn it. Tools: trending_now, interest_over_time, related_queries,
// add_trends_to_question. Prompt: ask_with_trends (slash command).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  TIMEFRAMES,
  buildTrendsContext,
  errorMessage,
  formatInterest,
  formatRelated,
  formatTrending,
  interestOverTime,
  relatedQueries,
  trendingNow,
  type Timeframe,
} from "./trends.js";

const DEFAULT_GEO = process.env.TRENDS_GEO ?? "US";

const geoSchema = z
  .string()
  .regex(/^[a-z]{2}(-[a-z0-9]{1,3})?$/i, "Use an ISO country code such as US, GB, IN or a region such as US-CA")
  .transform((g) => g.toUpperCase())
  .default(DEFAULT_GEO)
  .describe("Country or region code, e.g. US, GB, IN, PK, US-CA");

const timeframeSchema = z
  .enum(TIMEFRAMES as [Timeframe, ...Timeframe[]])
  .default("today 3-m")
  .describe("Google Trends time range");

const server = new McpServer({
  name: "google-trends",
  version: "0.1.0",
});

function text(body: string, structured?: Record<string, unknown>) {
  return structured
    ? { content: [{ type: "text" as const, text: body }], structuredContent: structured }
    : { content: [{ type: "text" as const, text: body }] };
}

function failure(e: unknown) {
  return { content: [{ type: "text" as const, text: `Google Trends error: ${errorMessage(e)}` }], isError: true };
}

// -- tools --------------------------------------------------------------------

server.registerTool(
  "trending_now",
  {
    title: "Trending now on Google",
    description:
      "Fetch the latest trending Google searches for a country, with approximate search volume and a related headline for each. Use this for 'what is trending right now' questions.",
    inputSchema: {
      geo: geoSchema,
      limit: z.number().int().min(1).max(50).default(20).describe("How many trends to return"),
    },
  },
  async ({ geo, limit }) => {
    try {
      const items = await trendingNow(geo, limit);
      return text(formatTrending(items, geo), { geo, items });
    } catch (e) {
      return failure(e);
    }
  },
);

server.registerTool(
  "interest_over_time",
  {
    title: "Google Trends interest over time",
    description:
      "Compare search interest for 1-5 keywords over a time range (0-100 relative scale, like the Google Trends chart). Use this to see whether something is rising or falling in popularity.",
    inputSchema: {
      keywords: z.array(z.string().min(1)).min(1).max(5).describe("1 to 5 search terms to compare"),
      geo: geoSchema,
      timeframe: timeframeSchema,
    },
  },
  async ({ keywords, geo, timeframe }) => {
    try {
      const data = await interestOverTime(keywords, geo, timeframe);
      return text(formatInterest(data), { ...data });
    } catch (e) {
      return failure(e);
    }
  },
);

server.registerTool(
  "related_queries",
  {
    title: "Google Trends related queries",
    description:
      "Get the top and rising related search queries for a keyword. 'Breakout' means the query grew by more than 5000%.",
    inputSchema: {
      keyword: z.string().min(1).describe("The search term"),
      geo: geoSchema,
      timeframe: timeframeSchema,
    },
  },
  async ({ keyword, geo, timeframe }) => {
    try {
      const data = await relatedQueries(keyword, geo, timeframe);
      return text(formatRelated(data), { ...data });
    } catch (e) {
      return failure(e);
    }
  },
);

server.registerTool(
  "add_trends_to_question",
  {
    title: "Add Google Trends data to a question",
    description:
      "Fetch the latest Google Trends data (trending searches, plus interest-over-time and related queries for any keywords given) and return the user's question with that data attached. Call this before answering any question that depends on what people are currently searching for, and then answer the enriched question.",
    inputSchema: {
      question: z.string().min(1).describe("The user's question, verbatim"),
      keywords: z
        .array(z.string().min(1))
        .max(5)
        .default([])
        .describe("Optional search terms from the question to look up in detail"),
      geo: geoSchema,
      timeframe: timeframeSchema,
      trending_limit: z.number().int().min(1).max(50).default(15),
    },
  },
  async ({ question, keywords, geo, timeframe, trending_limit }) => {
    try {
      const context = await buildTrendsContext({ geo, keywords, timeframe, trendingLimit: trending_limit });
      return text(`${context}\n\nQuestion: ${question}`, { geo, keywords, timeframe, context, question });
    } catch (e) {
      return failure(e);
    }
  },
);

// -- prompt -------------------------------------------------------------------

server.registerPrompt(
  "ask_with_trends",
  {
    title: "Ask with Google Trends context",
    description:
      "Fetches the latest Google Trends data and attaches it to the question you type after the command. Optional leading tokens: a country code like GB (or geo=GB) and keywords=term1,term2.",
    argsSchema: {
      geo: z.string().optional().describe("Country code such as GB, or geo=GB. Defaults to US."),
      keywords: z.string().optional().describe("keywords=term1,term2 to look up specific terms (max 5)"),
    },
  },
  async ({ geo, keywords }) => {
    const opts = parsePromptOptions([geo, keywords]);
    const context = await buildTrendsContext({ geo: opts.geo ?? DEFAULT_GEO, keywords: opts.keywords });
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${context}\n\nUse the Google Trends data above wherever it is relevant and say which trends you relied on. Answer the question the user typed after the ask_with_trends command. If they did not type a question, summarize what is trending and why.`,
          },
        },
      ],
    };
  },
);

// Editors hand each prompt argument a single whitespace token, in order, so the
// first words of a question can land in geo / keywords. Only treat a token as
// an option when it clearly is one: geo=XX, keywords=a,b or a bare UPPERCASE
// country code. Everything else is just part of the question and gets ignored
// here (the model still sees the full command line).
function parsePromptOptions(tokens: (string | undefined)[]): { geo?: string; keywords: string[] } {
  let geo: string | undefined;
  let keywords: string[] = [];
  for (const raw of tokens) {
    const t = (raw ?? "").trim();
    if (!t) continue;
    const g = /^geo=([a-z]{2}(?:-[a-z0-9]{1,3})?)$/i.exec(t) ?? /^([A-Z]{2}(?:-[A-Z0-9]{1,3})?)$/.exec(t);
    if (g) {
      geo = g[1].toUpperCase();
      continue;
    }
    const k = /^(?:keywords?|kw)=(.+)$/i.exec(t);
    if (k) {
      keywords = k[1]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 5);
    }
  }
  return { geo, keywords };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the protocol, don't console.log in here
  console.error(`google-trends MCP server ready (default geo ${DEFAULT_GEO})`);
}

main().catch((e) => {
  console.error("google-trends MCP server failed to start:", errorMessage(e));
  process.exit(1);
});
