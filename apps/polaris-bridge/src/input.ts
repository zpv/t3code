export type PendingRequest =
  | { kind: "question"; options: readonly string[] }
  | { kind: "approval" };

export type InputAction =
  | { type: "interrupt" }
  | { type: "refuse"; reason: string }
  | { type: "question"; text: string; option: number | null }
  | { type: "approval"; approved: boolean }
  | { type: "model"; value: string }
  | { type: "effort"; value: string }
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
  const command = /^\/(model|effort)\s+(.+)$/is.exec(trimmed);
  if (command)
    return { type: command[1] === "model" ? "model" : "effort", value: command[2]!.trim() };
  return { type: "message", text: input };
}
