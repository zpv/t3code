import { describe, expect, it } from "@effect/vitest";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  deriveEvents,
  eventFacts,
  effortOption,
  instanceFor,
  pendingRequest,
  renderSnapshot,
} from "./logic.ts";

const projection = (value: object) => value as OrchestrationV2ThreadProjection;

describe("bridge projection logic", () => {
  it("renders messages, tools, and a pending question with a line limit", () => {
    const p = projection({
      thread: { id: "thread" },
      runtimeRequests: [{ id: "q", status: "pending" }],
      turnItems: [
        {
          type: "user_input_request",
          requestId: "q",
          questions: [
            { id: "q1", question: "Which?", options: [{ label: "One" }, { label: "Two" }] },
          ],
        },
      ],
      visibleTurnItems: [
        { item: { type: "user_message", text: "hello" } },
        { item: { type: "command_execution", input: "ls\n -la" } },
        { item: { type: "assistant_message", text: "Hi" } },
      ],
    });
    expect(renderSnapshot(p, 20)).toBe("> hello\n⏺ Bash: ls -la\nHi\n? Which?\n1. One\n2. Two");
    expect(renderSnapshot(p, 2)).toBe("1. One\n2. Two");
  });
  it("derives stable events without echoing bridge messages across a restart", () => {
    const p = projection({
      thread: { id: "thread" },
      messages: [
        { id: "mine", role: "user", createdBy: "user", text: "mine" },
        { id: "ui", role: "user", createdBy: "user", text: "ui" },
        { id: "restart", role: "user", createdBy: "agent", text: "resume" },
        { role: "assistant", runId: "r", text: "first" },
        { role: "assistant", runId: "r", text: "last" },
      ],
      runs: [{ id: "r", status: "completed" }],
      runtimeRequests: [{ id: "q", status: "pending" }],
      turnItems: [
        {
          type: "user_input_request",
          requestId: "q",
          questions: [{ id: "question", question: "Which?", options: [{ label: "A" }] }],
        },
      ],
    });
    const events = deriveEvents(p, { events: [], dispatched: ["mine"] });
    expect(events.map((e) => e.type)).toEqual([
      "user.prompt",
      "assistant.completed",
      "claude.ask_user_question",
    ]);
    expect(events[1]?.payload.text).toBe("last");
    expect(events[2]?.payload.text).toBe("Which?\n1. A");
    const saved = JSON.parse(
      JSON.stringify({ events: events.map((event) => event.eventId), dispatched: ["mine"] }),
    );
    expect(deriveEvents(p, saved)).toEqual([]);
    const approval = projection({
      ...p,
      runtimeRequests: [{ id: "a", status: "pending" }],
      turnItems: [{ type: "approval_request", requestId: "a", title: "Bash", prompt: "rm file" }],
    });
    expect(pendingRequest(approval)?.kind).toBe("approval");
    expect(deriveEvents(approval, saved).at(-1)?.type).toBe("claude.notification");
  });
  it("replays a pending request even when the current projection is already resolved", () => {
    const p = projection({
      thread: { id: "thread" },
      messages: [],
      runs: [],
      runtimeRequests: [{ id: "q", status: "resolved" }],
      turnItems: [
        {
          type: "user_input_request",
          requestId: "q",
          questions: [{ id: "one", question: "Choose", options: [{ label: "A" }] }],
        },
      ],
    });
    const event = {
      type: "runtime-request.updated",
      payload: { id: "q", status: "pending" },
    } as OrchestrationV2DomainEvent;
    const facts = eventFacts(p, event);
    expect(deriveEvents(facts, { events: [], dispatched: [] })[0]?.type).toBe(
      "claude.ask_user_question",
    );
  });
  it("selects instances and validates effort options", () => {
    const warnings: string[] = [];
    const instances = { claude: { default: "claudeAgent", profiles: { main: "other" } } };
    expect(instanceFor("claude", "main", instances, (s) => warnings.push(s))).toBe("other");
    expect(instanceFor("claude", "missing", instances, (s) => warnings.push(s))).toBe(
      "claudeAgent",
    );
    expect(warnings).toHaveLength(1);
    const options = [
      {
        id: "reasoningEffort",
        type: "select",
        label: "Effort",
        options: [{ id: "high", label: "High" }],
      },
    ] as ProviderOptionDescriptor[];
    expect(effortOption("codex", "high", options)).toEqual({
      id: "reasoningEffort",
      value: "high",
    });
    expect(effortOption("claudeAgent", "high", options)).toBeUndefined();
    expect(effortOption("codex", "invalid", options)).toBeUndefined();
  });
});
