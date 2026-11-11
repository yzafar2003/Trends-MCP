#!/usr/bin/env node
// UserPromptSubmit hook for Claude Code. Runs before each prompt goes out and
// tacks the current trends onto it as extra context, so you don't have to
// rely on the model deciding to call a tool.
//
//   TRENDS_GEO           country code (US)
//   TRENDS_LIMIT         how many trending searches to include (10)
//   TRENDS_HOOK_TRIGGER  regex - if set, only inject when the prompt matches,
//                        e.g. "trend|popular|viral"
//
// If anything goes wrong we just print nothing and exit 0. Never block the
// prompt over this.

import { buildTrendsContext } from "./trends.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let prompt = "";
  try {
    prompt = String((JSON.parse(raw) as { prompt?: string }).prompt ?? "");
  } catch {
    prompt = raw;
  }

  const trigger = process.env.TRENDS_HOOK_TRIGGER;
  if (trigger && !new RegExp(trigger, "i").test(prompt)) return;

  const context = await buildTrendsContext({
    geo: process.env.TRENDS_GEO ?? "US",
    trendingLimit: Number(process.env.TRENDS_LIMIT ?? 10),
  });

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `${context}\nThis block was added automatically by the Trends-MCP hook. Use it when the question relates to current search interest; otherwise ignore it.`,
      },
    }),
  );
}

main().catch(() => {});
