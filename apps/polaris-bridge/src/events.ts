import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { pendingRequest, type Projection, type Event, type Marks } from "./logic.ts";

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
  const pending = pendingRequest(p, marks.answers);
  if (pending) {
    const text = pending.text + pending.options.map((o, i) => `\n${i + 1}. ${o}`).join("");
    add(
      `request:${pending.id}${pending.kind === "question" ? `:${pending.index}` : ""}`,
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
