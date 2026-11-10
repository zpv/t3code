// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Input receipts survive bridge restarts.
import * as NodeCrypto from "node:crypto";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import type { State } from "./state.ts";
import type { Event } from "./logic.ts";
import { Refusal } from "./t3Client.ts";

const retention = 8 * 24 * 60 * 60 * 1000;

export function createInputReceipts(
  state: State,
  save: () => void,
  dispatch: (command: OrchestrationV2Command) => Promise<unknown>,
) {
  const locks = new Map<string, Promise<unknown>>();
  return async function withReceipt(
    threadId: string,
    inputId: unknown,
    operation: (
      send: (command: OrchestrationV2Command, response: object, event?: Event) => Promise<object>,
      record: (response: object) => void,
    ) => Promise<object>,
  ): Promise<object> {
    if (inputId !== undefined && (typeof inputId !== "string" || !inputId.length))
      throw new Refusal("inputId must be a non-empty string");
    const previous = locks.get(threadId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        const entry = state.threads[threadId];
        if (!entry) throw new Refusal("Thread is not mapped");
        const now = Date.now();
        const inputs = (entry.inputs ??= {});
        for (const [key, receipt] of Object.entries(inputs))
          if (now - receipt.createdAt >= retention) delete inputs[key];
        const key =
          typeof inputId === "string"
            ? NodeCrypto.createHash("sha256").update(inputId).digest("hex")
            : undefined;
        const existing = key ? inputs[key] : undefined;
        const finish = (receipt: typeof existing) => {
          if (!receipt) return;
          if (receipt.event && !entry.events.includes(receipt.event.eventId)) {
            entry.events.push(receipt.event.eventId);
            entry.outbox.push(receipt.event);
          }
          receipt.pending = false;
          save();
        };
        if (existing) {
          if (existing.pending && existing.command) {
            await dispatch(existing.command);
            finish(existing);
          }
          if (existing.refusal) throw new Refusal(existing.refusal);
          return existing.response;
        }
        const record = (response: object) => {
          if (key) inputs[key] = { createdAt: now, response };
        };
        const send = async (command: OrchestrationV2Command, response: object, event?: Event) => {
          if (key) {
            inputs[key] = {
              createdAt: now,
              response,
              command,
              pending: true,
              ...(event ? { event } : {}),
            };
          }
          save();
          await dispatch(command);
          if (key) {
            finish(inputs[key]);
          } else if (event) {
            entry.events.push(event.eventId);
            entry.outbox.push(event);
            save();
          }
          return response;
        };
        let result: object;
        try {
          result = await operation(send, record);
        } catch (error) {
          if (key && !inputs[key] && error instanceof Refusal) {
            inputs[key] = { createdAt: now, response: {}, refusal: error.message };
            save();
          }
          throw error;
        }
        if (key && !inputs[key]) inputs[key] = { createdAt: now, response: result };
        save();
        return result;
      });
    locks.set(threadId, run);
    try {
      return await run;
    } finally {
      if (locks.get(threadId) === run) locks.delete(threadId);
    }
  };
}
