// quick end to end check - spawns dist/index.js over stdio the same way an
// editor would and calls each tool against real google trends.
// npm run build && npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const firstLine = (s) => s.split("\n").slice(0, 3).join("\n");
const show = (label, result) => {
  const body = result.content?.[0]?.text ?? JSON.stringify(result);
  console.log(`\n## ${label}${result.isError ? " (ERROR)" : ""}\n${firstLine(body)}\n...`);
  if (result.isError) process.exitCode = 1;
};

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const { prompts } = await client.listPrompts();
console.log("prompts:", prompts.map((p) => p.name).join(", "));

show("trending_now", await client.callTool({ name: "trending_now", arguments: { geo: "US", limit: 5 } }));
show(
  "interest_over_time",
  await client.callTool({ name: "interest_over_time", arguments: { keywords: ["bitcoin", "ethereum"] } }),
);
show("related_queries", await client.callTool({ name: "related_queries", arguments: { keyword: "bitcoin" } }));
show(
  "add_trends_to_question",
  await client.callTool({
    name: "add_trends_to_question",
    arguments: { question: "Is bitcoin getting more popular?", keywords: ["bitcoin"] },
  }),
);

const prompt = await client.getPrompt({
  name: "ask_with_trends",
  arguments: { geo: "GB", keywords: "keywords=bitcoin" },
});
console.log("\n## ask_with_trends prompt\n" + firstLine(prompt.messages[0].content.text) + "\n...");

await client.close();
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
