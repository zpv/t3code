import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";

export type Projection = OrchestrationV2ThreadProjection;
export type Event = {
  eventId: string;
  type: string;
  source: "t3-bridge";
  payload: Record<string, unknown>;
};
export type Marks = { events: string[]; dispatched: string[] };

export function instanceFor(
  agent: string,
  profile: string | undefined,
  instances: Record<string, { default: string; profiles: Record<string, string> }>,
  warn: (message: string) => void,
): string {
  const entry = instances[agent];
  const fallback =
    entry?.default ??
    (agent === "claude" ? "claudeAgent" : agent === "replay" ? "devReplay" : agent);
  if (profile && !entry?.profiles[profile])
    warn(`Unknown ${agent} profile ${profile}; using ${fallback}`);
  return (profile && entry?.profiles[profile]) || fallback;
}

export function effortOption(
  driver: string,
  value: string | null | undefined,
  options: readonly ProviderOptionDescriptor[],
) {
  const option = options.find(
    (item) =>
      item.type === "select" &&
      (driver === "claudeAgent" ? item.id === "effort" : /effort|reasoning/i.test(item.id)),
  );
  return option?.type === "select" && value && option.options.some((choice) => choice.id === value)
    ? { id: option.id, value }
    : undefined;
}

export function pendingRequest(p: Projection) {
  const request = p.runtimeRequests.find((r) => r.status === "pending");
  if (!request) return null;
  const item = p.turnItems.find(
    (i) =>
      (i.type === "user_input_request" || i.type === "approval_request") &&
      i.requestId === request.id,
  );
  if (!item) return null;
  if (item.type === "user_input_request") {
    const question = item.questions[0];
    if (!question) return null;
    return {
      id: request.id,
      kind: "question" as const,
      text: question.question,
      options: question.options.map((option) => option.label),
      question,
    };
  }
  if (item.type !== "approval_request") return null;
  return {
    id: request.id,
    kind: "approval" as const,
    text: [item.title, item.prompt, item.reason].filter(Boolean).join(": "),
    options: [] as string[],
  };
}

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

export function deriveEvents(p: Projection, marks: Marks): Event[] {
  const seen = new Set(marks.events);
  const dispatched = new Set(marks.dispatched);
  const thread = p.thread.id;
  const events: Event[] = [];
  const add = (id: string, type: string, payload: Record<string, unknown>) => {
    const eventId = `t3:${thread}:${id}`;
    if (!seen.has(eventId)) events.push({ eventId, type, source: "t3-bridge", payload });
  };
  for (const message of p.messages)
    if (message.role === "user" && message.createdBy === "user" && !dispatched.has(message.id))
      add(`message:${message.id}`, "user.prompt", {
        text: message.text,
        messageId: message.id,
        origin: "t3",
      });
  for (const run of p.runs) {
    if (!["completed", "interrupted", "failed", "cancelled"].includes(run.status)) continue;
    const last = p.messages
      .filter((message) => message.role === "assistant" && message.runId === run.id)
      .at(-1);
    if (last?.text)
      add(`run:${run.id}:terminal`, "assistant.completed", {
        text: last.text,
        t3RunId: run.id,
        status: run.status === "cancelled" ? "interrupted" : run.status,
      });
    else if (run.status === "failed") {
      const error = p.turnItems.findLast((item) => item.runId === run.id && item.type === "error");
      add(`run:${run.id}:terminal`, "t3.run.failed", {
        text: error?.type === "error" ? error.failure.message : "Run failed",
        t3RunId: run.id,
      });
    }
  }
  const pending = pendingRequest(p);
  if (pending) {
    const text = pending.text + pending.options.map((o, i) => `\n${i + 1}. ${o}`).join("");
    add(
      `request:${pending.id}`,
      pending.kind === "question" ? "claude.ask_user_question" : "claude.notification",
      {
        text,
        requestId: pending.id,
        ...(pending.kind === "question"
          ? { options: pending.options, notification_type: "ask_user_question" }
          : { notification_type: "permission_prompt" }),
      },
    );
  }
  return events;
}

export function eventFacts(p: Projection, event: OrchestrationV2DomainEvent): Projection {
  const empty = { ...p, messages: [], runs: [], runtimeRequests: [] };
  switch (event.type) {
    case "message.updated":
      return { ...empty, messages: [event.payload] };
    case "run.created":
    case "run.updated":
      return {
        ...empty,
        runs: [event.payload],
        messages: p.messages.filter(
          (message) => message.role === "assistant" && message.runId === event.payload.id,
        ),
      };
    case "runtime-request.updated":
      return { ...empty, runtimeRequests: [event.payload] };
    default:
      return empty;
  }
}
