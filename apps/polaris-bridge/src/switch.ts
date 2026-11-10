import type { Event } from "./logic.ts";
import type { Entry } from "./state.ts";

type Intent = NonNullable<Entry["switching"]>;

export async function resumeSwitch(
  threadId: string,
  entry: Entry,
  operations: {
    save: () => void;
    current: () => Promise<string>;
    move: (from: string, to: string, commandId: string) => Promise<boolean>;
    dispatch: (intent: Intent) => Promise<void>;
    post: (event: Event) => Promise<void>;
  },
) {
  const intent = entry.switching;
  if (!intent) return false;
  const current = await operations.current();
  if (
    (current !== intent.from && current !== intent.to) ||
    (current === intent.from &&
      !(await operations.move(intent.from, intent.to, intent.moveCommandId)))
  ) {
    entry.switchRuns = [...new Set([...(entry.switchRuns ?? []), intent.failedRunId])];
    delete entry.switching;
    operations.save();
    return false;
  }
  if (!entry.dispatched.includes(intent.messageId)) {
    entry.dispatched.push(intent.messageId);
    operations.save();
  }
  await operations.dispatch(intent);
  await operations.post(intent.event);
  if (!entry.events.includes(intent.event.eventId)) entry.events.push(intent.event.eventId);
  const terminalId = `t3:${threadId}:run:${intent.failedRunId}:terminal`;
  if (!entry.events.includes(terminalId)) entry.events.push(terminalId);
  entry.switchRuns = [...new Set([...(entry.switchRuns ?? []), intent.failedRunId])];
  delete entry.switching;
  operations.save();
  return true;
}
