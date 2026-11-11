#!/usr/bin/env node
/**
 * Claude Code "UserPromptSubmit" hook.
 *
 * Claude Code runs this before every prompt is sent to the model. It fetches
 * the latest Google Trends data and returns it as additional context, so the
 * data is added to the question automatically without the model having to
 * call a tool first.
 *
 * Environment:
 *   TRENDS_GEO           country code, default US
 *   TRENDS_LIMIT         how many trending searches to include, default 10
 *   TRENDS_HOOK_TRIGGER  optional regex; when set, context is only added if the
 *                        prompt matches it (e.g. "trend|popular|viral")
 *
 * Any failure exits 0 with no output so the prompt is never blocked.
 */

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

main().catch(() => {
  /* never block the prompt */
});
