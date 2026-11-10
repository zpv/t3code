// @effect-diagnostics nodeBuiltinImport:off -- The bridge formats terminal text for Discord.
import * as NodeUtil from "node:util";
import type {
  OrchestrationV2ThreadProjection,
  ProviderOptionDescriptor,
  ServerProviderModel,
  ServerDirectEndpoint,
} from "@t3tools/contracts";

export type Projection = OrchestrationV2ThreadProjection;
export type Event = {
  eventId: string;
  type: string;
  source: "t3-bridge";
  payload: Record<string, unknown>;
};
export type Marks = {
  events: string[];
  dispatched: string[];
  inputMessages?: string[];
  answers?: { requestId: string; values: Record<string, string> };
};

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

export function pendingRequest(p: Projection, answers?: Marks["answers"]) {
  const request = p.runtimeRequests.find((r) => r.status === "pending");
  if (!request) return null;
  const item = p.turnItems.find(
    (i) =>
      (i.type === "user_input_request" || i.type === "approval_request") &&
      i.requestId === request.id,
  );
  if (!item) return null;
  if (item.type === "user_input_request") {
    const index =
      answers?.requestId === request.id
        ? item.questions.findIndex((q) => !(q.id in answers.values))
        : 0;
    const question = item.questions[index];
    if (!question) return null;
    return {
      id: request.id,
      kind: "question" as const,
      text: question.question,
      options: question.options.map((option) => option.label),
      question,
      questions: item.questions,
      index,
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

export function resolveModel(
  models: readonly ServerProviderModel[],
  value: string,
): string | undefined {
  const exact = models.find((model) => model.slug === value);
  if (exact) return exact.slug;
  const lower = value.toLowerCase();
  const alias = models.filter((model) => model.aliases?.some((a) => a.toLowerCase() === lower));
  if (alias.length === 1) return alias[0]?.slug;
  const matches = models.filter((model) => model.slug.toLowerCase().includes(lower));
  return matches.length === 1 ? matches[0]?.slug : undefined;
}

export function publicOrigin(
  explicit: string | undefined,
  endpoints: readonly ServerDirectEndpoint[],
  fallback: string,
): string {
  return (
    explicit ||
    endpoints.find((e) => e.kind === "tailnet" && e.httpBaseUrl.startsWith("https://"))
      ?.httpBaseUrl ||
    endpoints.find((e) => e.kind === "tailnet")?.httpBaseUrl ||
    endpoints.find((e) => e.kind === "lan")?.httpBaseUrl ||
    fallback
  ).replace(/\/$/, "");
}

export function formatReply(text: string): string {
  return NodeUtil.stripVTControlCharacters(text).slice(0, 1800);
}
