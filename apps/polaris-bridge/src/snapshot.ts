import { pendingRequest, type Projection } from "./logic.ts";

export function renderSnapshot(p: Projection, lines: number): string {
  const output: string[] = [];
  for (const { item } of p.visibleTurnItems) {
    if (item.type === "user_message") output.push(...item.text.split("\n").map((s) => `> ${s}`));
    else if (item.type === "assistant_message") output.push(item.text);
    else if (item.type === "command_execution")
      output.push(`⏺ Bash: ${item.input.replace(/\s+/g, " ")}`);
    else if (item.type === "file_change") output.push(`⏺ Edit: ${item.fileName}`);
    else if (item.type === "file_search") output.push(`⏺ Search: ${item.pattern ?? ""}`);
    else if (item.type === "web_search")
      output.push(`⏺ Web search: ${(item.patterns ?? []).join(", ")}`);
    else if (item.type === "dynamic_tool")
      output.push(
        `⏺ ${item.toolName ?? "Tool"}: ${typeof item.input === "string" ? item.input.replace(/\s+/g, " ") : JSON.stringify(item.input)}`,
      );
  }
  const pending = pendingRequest(p);
  if (pending)
    output.push(`? ${pending.text}${pending.options.map((o, i) => `\n${i + 1}. ${o}`).join("")}`);
  return output.join("\n").split("\n").slice(-Math.max(1, lines)).join("\n");
}
