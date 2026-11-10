export type PendingRequest =
  | { kind: "question"; options: readonly string[] }
  | { kind: "approval" };

export type InputAction =
  | { type: "interrupt" }
  | { type: "refuse"; reason: string }
  | { type: "question"; text: string; option: number | null }
  | { type: "approval"; approved: boolean }
  | {
      type: "model" | "effort" | "account" | "status" | "usage" | "context" | "clear";
      value: string;
    }
  | { type: "message"; text: string };

export function interpretInput(input: string, pending: PendingRequest | null): InputAction {
  const trimmed = input.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 0 && tokens.every((token) => /^\$[\w-]+$/.test(token))) {
    if (tokens.some((token) => ["$esc", "$cc", "$ctrl-c"].includes(token.toLowerCase()))) {
      return { type: "interrupt" };
    }
    return { type: "refuse", reason: "T3 threads have no terminal keys" };
  }
  if (pending?.kind === "question") {
    const option = /^\d{1,2}$/.test(trimmed) ? Number(trimmed) : null;
    if (option !== null && (option < 1 || option > pending.options.length)) {
      return { type: "refuse", reason: "Question option is out of range" };
    }
    return { type: "question", text: input, option };
  }
  if (pending?.kind === "approval") {
    if (/^(y|yes|approve|1)$/i.test(trimmed)) return { type: "approval", approved: true };
    if (/^(n|no|deny|2)$/i.test(trimmed)) return { type: "approval", approved: false };
  }
  const command = /^\/(model|effort|account)(?:\s+(.+))?$/is.exec(trimmed);
  if (command)
    return {
      type: command[1]!.toLowerCase() as "model" | "effort" | "account",
      value: (command[2] ?? "").trim(),
    };
  const query = /^\/(status|usage|context|clear)$/i.exec(trimmed);
  if (query)
    return { type: query[1]!.toLowerCase() as "status" | "usage" | "context" | "clear", value: "" };
  return { type: "message", text: input };
}
