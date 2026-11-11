# Trends-MCP

An [MCP](https://modelcontextprotocol.io) server that fetches the latest **Google Trends** data and adds it to the question sent to the model. Works with **Claude Code** and **Cursor**.

What it does:

1. Runs as a stdio MCP server so Claude Code or Cursor can spawn it.
2. Pulls live Google Trends data: trending searches, interest over time, related queries.
3. Adds that data to your question, either when you ask (tool / slash command) or on every prompt (Claude Code hook).

No API key. Google Trends doesn't have a public API, so this uses the same endpoints the trends.google.com site uses and caches results for five minutes so Google doesn't start rate limiting.

## Requirements

- Node.js 18 or newer

## Install

```bash
git clone https://github.com/yzafar2003/Trends-MCP.git
cd Trends-MCP
npm install        # also compiles to dist/
npm run smoke      # optional: hits live Google Trends through the server
```

## Connect to Claude Code

**Option A: per project.** Open Claude Code inside the cloned folder. The included `.mcp.json` registers the server automatically. Approve it when prompted.

**Option B: everywhere.** Register it once for your user:

```bash
claude mcp add --scope user google-trends -- node "C:/path/to/Trends-MCP/dist/index.js"
```

Verify with `claude mcp list`. You should see `google-trends: ... - ✓ Connected`.

Then either ask naturally ("what is trending in the UK right now?") and Claude will call the tools, or use the slash command, which fetches the data and sends it with your question:

```
/mcp__google-trends__ask_with_trends What should my next blog post be about?
```

### Automatic injection on every prompt (Claude Code hook)

If you want the trends data added to **every** question without asking, add a `UserPromptSubmit` hook. Put this in `.claude/settings.json` (project) or `~/.claude/settings.json` (user), adjusting the path:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/path/to/Trends-MCP/dist/hook.js\"",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

A ready-made copy is in `hooks/claude-code-settings.example.json`. The hook never blocks a prompt: if Google Trends is unreachable it silently adds nothing.

Hook environment variables (set them in the `"env"` of the hook command or your shell):

| Variable              | Default | Meaning                                                              |
| --------------------- | ------- | -------------------------------------------------------------------- |
| `TRENDS_GEO`          | `US`    | Country code for trending searches                                   |
| `TRENDS_LIMIT`        | `10`    | How many trending searches to include                                |
| `TRENDS_HOOK_TRIGGER` | unset   | Regex. When set, data is only added if the prompt matches it, e.g. `trend\|popular\|viral` |

## Connect to Cursor

Add the server to `.cursor/mcp.json` in your project (a copy is included in this repo) or to `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "google-trends": {
      "command": "node",
      "args": ["C:/path/to/Trends-MCP/dist/index.js"],
      "env": { "TRENDS_GEO": "US" }
    }
  }
}
```

Enable it under **Cursor Settings → MCP**. In Agent mode, Cursor will call `add_trends_to_question` or the other tools when your question depends on what people are searching for. The `ask_with_trends` prompt is also available where Cursor exposes MCP prompts.

## What the server exposes

### Tools

| Tool                      | What it does                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `trending_now`            | Latest trending searches for a country, with approximate volume and a headline each.                  |
| `interest_over_time`      | 0-100 search interest for 1 to 5 keywords over a timeframe, like the Google Trends chart.             |
| `related_queries`         | Top and rising related queries for a keyword. "Breakout" means growth above 5000%.                    |
| `add_trends_to_question`  | Fetches everything above and returns the user's question with the data attached, ready to answer.     |

Common arguments: `geo` (ISO country or region code, e.g. `US`, `GB`, `IN`, `PK`, `US-CA`) and `timeframe` (one of `now 1-H`, `now 4-H`, `now 1-d`, `now 7-d`, `today 1-m`, `today 3-m`, `today 12-m`, `today 5-y`).

### Prompt

`ask_with_trends(question, geo?, keywords?)` returns a single user message containing the trends block followed by the question. Claude Code exposes it as `/mcp__google-trends__ask_with_trends`.

### What the injected block looks like

```
<google_trends fetched_at="2026-11-11T10:01:44Z" geo="US">
Trending now on Google (US):
1. when is black friday 2026 (500+ searches) - Early Amazon Kitchen Deals ... (Allrecipes)
2. side effect (5000+ searches) - FDA orders new warning labels on Ozempic ... (Fox Business)
...

Interest over time (US, today 3-m, 0-100 scale):
  bitcoin: avg 47, ethereum: avg 6
  Most recent points:
  Nov 10, 2026: bitcoin=43, ethereum=5
  ...

Related queries for "bitcoin" (US, today 3-m):
  Top:
  bitcoin price (100)
  Rising:
  british man recovers lost bitcoin (Breakout)
</google_trends>

Question: Is bitcoin getting more popular?
```

## Server environment variables

| Variable                  | Default  | Meaning                                       |
| ------------------------- | -------- | --------------------------------------------- |
| `TRENDS_GEO`              | `US`     | Default country when a tool call omits `geo`  |
| `TRENDS_CACHE_TTL_MS`     | `300000` | How long fetched data is reused (5 minutes)   |
| `TRENDS_FETCH_TIMEOUT_MS` | `15000`  | Per-request timeout                           |

## Development

```bash
npm run build   # compile src/ to dist/
npm run dev     # recompile on change
npm run smoke   # spawn the server over stdio and call every tool against live data
```

Source layout:

- `src/trends.ts`: Google Trends client (RSS trending feed, explore tokens, widget data, caching, formatting).
- `src/index.ts`: MCP server with the tools and prompt.
- `src/hook.ts`: Claude Code `UserPromptSubmit` hook.
- `scripts/smoke.mjs`: end-to-end check using the MCP client SDK.

## Caveats

- The explore endpoints get rate limited fairly easily. If you see HTTP 429, wait a minute and retry. The trending RSS feed is much more forgiving and is always fetched first.
- "Trending now" is whatever Google puts in the RSS feed, roughly the last 24h per country.
- These are unofficial endpoints. They could change or break at any time.

## License

MIT
