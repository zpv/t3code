// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off -- The bridge dispatches input and attachments.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  type ThreadId,
  type ChatAttachment,
  type ServerConfig,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import type { Account } from "./accounts.ts";
import { chooseAccount } from "./accounts.ts";
import type { ConfigFile } from "./config.ts";
import type { State } from "./state.ts";
import type { Client } from "./t3Client.ts";
import { Refusal } from "./t3Client.ts";
import { pendingRequest, resolveModel, effortOption, formatReply, type Event } from "./logic.ts";
import { turnState, effort } from "./threads.ts";
import { createInputReceipts } from "./inputReceipts.ts";
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

type InputContext = {
  readonly file: ConfigFile;
  readonly serverConfig: ServerConfig | undefined;
  state: State;
  save: () => void;
  accounts: () => Account[];
  refreshUsage: () => Promise<void>;
  projection: (id: string) => Promise<OrchestrationV2ThreadProjection>;
  requireClient: () => Client;
  commandId: () => CommandId;
  messageId: () => MessageId;
  threadId: (id: string) => ThreadId;
  origin: string;
  link: (id: string) => string;
  flush: (id: string, p: OrchestrationV2ThreadProjection) => Promise<void>;
  watch: (id: string) => void;
};
export function createInputService(ctx: InputContext) {
  const {
    state,
    save,
    accounts,
    refreshUsage,
    projection,
    requireClient,
    commandId,
    messageId,
    threadId,
    origin,
    link,
    flush,
    watch,
  } = ctx;
  async function upload(files: { path: string; name?: string }[]): Promise<ChatAttachment[]> {
    const attachments: ChatAttachment[] = [];
    for (const item of files) {
      const name = item.name ?? NodePath.basename(item.path);
      const handle = await NodeFSP.open(item.path, "r");
      const header = Buffer.alloc(12);
      let size: number;
      try {
        size = (await handle.stat()).size;
        await handle.read(header, 0, header.length, 0);
      } finally {
        await handle.close();
      }
      const signature = header.toString("hex");
      const imageMime = signature.startsWith("89504e470d0a1a0a")
        ? "image/png"
        : signature.startsWith("ffd8ff")
          ? "image/jpeg"
          : header.subarray(0, 6).toString("ascii") === "GIF87a" ||
              header.subarray(0, 6).toString("ascii") === "GIF89a"
            ? "image/gif"
            : header.subarray(0, 4).toString("ascii") === "RIFF" &&
                header.subarray(8, 12).toString("ascii") === "WEBP"
              ? "image/webp"
              : undefined;
      const type = imageMime ? "image" : "file";
      const mime =
        imageMime ??
        ({ ".pdf": "application/pdf", ".txt": "text/plain" } as Record<string, string>)[
          NodePath.extname(name).toLowerCase()
        ] ??
        "application/octet-stream";
      if (size === 0 || size > (type === "image" ? 10 : 50) * 1024 * 1024)
        throw new Refusal(`${name} is empty or exceeds the ${type === "image" ? 10 : 50} MB limit`);
      const data = await NodeFSP.readFile(item.path);
      if (data.length !== size) throw new Refusal(`${name} changed while being uploaded`);
      const minted = await Effect.runPromise(
        requireClient()["attachments.createUploadUrl"](
          type === "image"
            ? {
                type,
                name,
                mimeType: mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                sizeBytes: data.length,
              }
            : { type, name, mimeType: mime, sizeBytes: data.length },
        ),
      );
      const response = await fetch(new URL(minted.relativeUrl, origin), {
        method: "POST",
        headers: { "Content-Type": mime },
        body: data,
      });
      if (!response.ok) throw new Error(`Upload ${name} failed: ${response.status}`);
      attachments.push({
        id: minted.attachmentId,
        type,
        name,
        mimeType: mime,
        sizeBytes: data.length,
      });
    }
    return attachments;
  }
  async function changeAccount(
    id: string,
    profile: string,
    reason: "manual" | "usage_limit" = "manual",
    flushChanges = true,
    resetAt?: string,
    moveCommandId?: string,
    suppressEvent = false,
    send?: (command: OrchestrationV2Command, response: object, event?: Event) => Promise<object>,
  ) {
    const { file, serverConfig } = ctx;
    const p = await projection(id);
    const from = accounts().find((a) => a.id === p.thread.providerInstanceId);
    if (!from) throw new Refusal("Current account is unavailable");
    const target = chooseAccount(
      accounts(),
      from.agent,
      profile,
      false,
      file.accounts?.switchAtPercent ?? 97,
    );
    if (!target) throw new Refusal(`Account unavailable: ${profile}`);
    const oldProvider = serverConfig?.providers.find((v) => v.instanceId === from.id);
    const newProvider = serverConfig?.providers.find((v) => v.instanceId === target.id);
    if (!newProvider) throw new Refusal("Account provider is unavailable");
    const resume =
      oldProvider?.driver === newProvider.driver &&
      oldProvider.continuation?.groupKey &&
      oldProvider.continuation.groupKey === newProvider.continuation?.groupKey
        ? "native"
        : "handoff";
    const current = p.thread.modelSelection;
    const model =
      resolveModel(newProvider.models, current.model) ??
      newProvider.models.find((m) => m.isDefault)?.slug ??
      newProvider.models[0]?.slug;
    if (!model) throw new Refusal("Account has no available model");
    if (reason === "manual" && state.threads[id]) {
      state.threads[id]!.accountChangedAt = Date.now();
      save();
    }
    if (from.id !== target.id) {
      const entry = state.threads[id];
      const event: Event | undefined =
        entry && !suppressEvent
          ? {
              eventId: `t3:${id}:account:${NodeCrypto.randomUUID()}`,
              type: "t3.account.switched",
              source: "t3-bridge",
              payload: {
                text:
                  reason === "usage_limit"
                    ? `${from.label} hit its limit${resetAt ? ` (resets ${resetAt})` : ""}. Continuing on ${target.label}.`
                    : `${from.label} account changed to ${target.label}.`,
                from: from.profile,
                to: target.profile,
                reason,
                resume,
                link: link(id),
              },
            }
          : undefined;
      const command = {
        type: "thread.model-selection.set" as const,
        commandId: moveCommandId ? CommandId.make(moveCommandId) : commandId(),
        threadId: threadId(id),
        modelSelection: { instanceId: ProviderInstanceId.make(target.id), model },
      };
      if (send) {
        await send(
          command,
          {
            ok: true,
            delivery: "configured",
            messageId: null,
            reply: formatReply(`Account: ${target.label} (${resume})`),
          },
          event,
        );
      } else {
        await Effect.runPromise(requireClient()["orchestration.dispatchCommand"](command));
      }
      if (entry && event && !send) {
        entry.events.push(event.eventId);
        entry.outbox.push(event);
        save();
      }
      if (entry && event && flushChanges) await flush(id, await projection(id));
    }
    return {
      ok: true,
      account: { id: target.id, profile: target.profile, label: target.label },
      resume,
    };
  }
  const withReceipt = createInputReceipts(state, save, (command) =>
    Effect.runPromise(requireClient()["orchestration.dispatchCommand"](command)),
  );
  async function inputOnce(
    id: string,
    body: { input: string; attachments?: { path: string; name?: string }[] },
    send: (command: OrchestrationV2Command, response: object, event?: Event) => Promise<object>,
    record: (response: object) => void,
  ) {
    const { serverConfig } = ctx;
    if (typeof body.input !== "string") throw new Refusal("input must be a string");
    const p = await projection(id),
      pending = pendingRequest(p, state.threads[id]?.answers);
    const action = interpretInput(body.input, pending);
    const thread = threadId(id),
      active = p.runs.findLast((r) =>
        ["preparing", "starting", "running", "waiting"].includes(r.status),
      );
    if (action.type === "refuse") throw new Refusal(action.reason);
    if (action.type === "interrupt") {
      if (!active) return { ok: true, delivery: "idle", messageId: null };
      return send(
        {
          type: "run.interrupt",
          commandId: commandId(),
          threadId: thread,
          runId: active.id,
        },
        { ok: true, delivery: "interrupted", messageId: null },
      );
    }
    if (action.type === "question" && pending?.kind === "question") {
      const answer =
        action.option === null
          ? action.text
          : (pending.question.options[action.option - 1]?.value ??
            pending.question.options[action.option - 1]!.label);
      const entry = state.threads[id];
      if (!entry) throw new Refusal("Thread is not mapped");
      const values = {
        ...(entry.answers?.requestId === pending.id ? entry.answers.values : {}),
        [pending.question.id]: answer,
      };
      if (pending.questions.every((question) => question.id in values)) {
        delete entry.answers;
        return send(
          {
            type: "runtime-request.respond",
            commandId: commandId(),
            threadId: thread,
            requestId: pending.id,
            answers: values,
          },
          { ok: true, delivery: "answered", messageId: null },
        );
      } else {
        entry.answers = { requestId: pending.id, values };
        record({ ok: true, delivery: "answered", messageId: null });
        save();
        await flush(id, p);
      }
      return { ok: true, delivery: "answered", messageId: null };
    }
    if (action.type === "approval" && pending) {
      return send(
        {
          type: "runtime-request.respond",
          commandId: commandId(),
          threadId: thread,
          requestId: pending.id,
          decision: action.approved ? "accept" : "decline",
        },
        { ok: true, delivery: "answered", messageId: null },
      );
    }
    if (action.type === "account") {
      const current = accounts().find((a) => a.id === p.thread.providerInstanceId);
      if (!current) throw new Refusal("Current account is unavailable");
      if (!action.value)
        return {
          ok: true,
          delivery: "replied",
          messageId: null,
          reply: formatReply(
            `Account: ${current.label} (${current.profile})\nAvailable: ${accounts()
              .filter((a) => a.agent === current.agent)
              .map((a) => a.profile)
              .join(", ")}`,
          ),
        };
      const changed = await changeAccount(
        id,
        action.value,
        "manual",
        true,
        undefined,
        undefined,
        false,
        send,
      );
      return {
        ok: true,
        delivery: "configured",
        messageId: null,
        reply: formatReply(`Account: ${changed.account.label} (${changed.resume})`),
      };
    }
    if (action.type === "usage") {
      await refreshUsage();
      const current = accounts().find((a) => a.id === p.thread.providerInstanceId);
      const lines = accounts()
        .filter((a) => a.agent === current?.agent)
        .map(
          (a) =>
            `${a.label}: ${a.usage?.windows.map((w) => `${w.label} ${w.usedPercent}%${w.resetsAt ? ` resets ${w.resetsAt}` : ""}`).join(", ") || "usage unavailable"}`,
        );
      return {
        ok: true,
        delivery: "replied",
        messageId: null,
        reply: formatReply(lines.join("\n")),
      };
    }
    if (action.type === "clear") {
      if (!serverConfig?.environment.capabilities.freshContext)
        throw new Refusal("Fresh context is unavailable on this server");
      const entry = state.threads[id];
      if (!entry) throw new Refusal("Thread is not mapped");
      entry.freshContext = true;
      record({
        ok: true,
        delivery: "configured",
        messageId: null,
        reply: "The next message starts a fresh session.",
      });
      save();
      return {
        ok: true,
        delivery: "configured",
        messageId: null,
        reply: "The next message starts a fresh session.",
      };
    }
    if (action.type === "status")
      return {
        ok: true,
        delivery: "replied",
        messageId: null,
        reply: formatReply(
          `State: ${turnState(p)}\nModel: ${p.thread.modelSelection.model}\nEffort: ${effort(p) ?? "default"}\nAccount: ${accounts().find((a) => a.id === p.thread.providerInstanceId)?.label ?? p.thread.providerInstanceId}\nBranch: ${p.thread.branch ?? "none"}\nWorktree: ${p.thread.worktreePath ?? "root"}\nLink: ${link(id)}`,
        ),
      };
    if (action.type === "context") {
      const usage = p.providerThreads.find(
        (thread) => thread.id === p.thread.activeProviderThreadId,
      )?.contextUsage;
      return {
        ok: true,
        delivery: "replied",
        messageId: null,
        reply: usage
          ? `Context: ${usage.usedTokens} tokens${usage.maxTokens ? ` / ${usage.maxTokens}` : ""}`
          : "Context-window usage is unavailable.",
      };
    }
    if (action.type === "model" || action.type === "effort") {
      const current = p.thread.modelSelection;
      const provider = serverConfig?.providers.find((v) => v.instanceId === current.instanceId);
      if (!provider) throw new Refusal("Provider is unavailable");
      const models = provider.models.map((m) => m.slug).join(", ");
      if (action.type === "model" && !action.value)
        return {
          ok: true,
          delivery: "replied",
          messageId: null,
          reply: formatReply(`Current model: ${current.model}\nAvailable: ${models}`),
        };
      const model =
        action.type === "model" ? resolveModel(provider.models, action.value) : current.model;
      if (!model) throw new Refusal(`Unknown model. Available: ${models}`);
      if (action.type === "effort" && !action.value) {
        const descriptors =
          provider.models.find((m) => m.slug === model)?.capabilities?.optionDescriptors ?? [];
        const descriptor = descriptors.find(
          (o) => o.type === "select" && /effort|reasoning/i.test(o.id),
        );
        return {
          ok: true,
          delivery: "replied",
          messageId: null,
          reply: formatReply(
            `Current effort: ${effort(p) ?? "default"}\nAvailable: ${descriptor?.type === "select" ? descriptor.options.map((o) => o.id).join(", ") : "none"}`,
          ),
        };
      }
      const selected =
        action.type === "effort"
          ? effortOption(
              provider?.driver ?? "",
              action.value,
              provider?.models.find((m) => m.slug === model)?.capabilities?.optionDescriptors ?? [],
            )
          : undefined;
      if (action.type === "effort" && !selected)
        throw new Refusal(`Unsupported effort: ${action.value}`);
      const options =
        action.type === "effort"
          ? [...(current.options ?? []).filter((o) => o.id !== selected!.id), selected!]
          : (current.options ?? []).filter((o) => {
              const descriptor = provider.models
                .find((m) => m.slug === model)
                ?.capabilities?.optionDescriptors?.find((d) => d.id === o.id);
              return (
                descriptor?.type === "select" &&
                descriptor.options.some((choice) => choice.id === o.value)
              );
            });
      return send(
        {
          type: "thread.model-selection.set",
          commandId: commandId(),
          threadId: thread,
          modelSelection: {
            instanceId: current.instanceId,
            model,
            ...(options.length ? { options } : {}),
          },
        },
        { ok: true, delivery: "configured", messageId: null },
      );
    }
    if (action.type !== "message") throw new Refusal("Cannot answer this request");
    const attachments = await upload(body.attachments ?? []);
    const mid = messageId();
    const entry = state.threads[id];
    if (!entry) throw new Refusal("Thread is not mapped");
    entry.dispatched.push(mid);
    (entry.inputMessages ??= []).push(mid);
    const freshContext = entry.freshContext;
    delete entry.freshContext;
    const result = await send(
      {
        type: "message.dispatch",
        commandId: commandId(),
        threadId: thread,
        messageId: mid,
        text: action.text,
        attachments,
        dispatchMode: { type: active ? "queue_after_active" : "start_immediately" },
        createdBy: "user",
        creationSource: "server",
        ...(freshContext ? { freshContext: true } : {}),
      },
      { ok: true, delivery: active ? "queued" : "started", messageId: mid },
    );
    watch(id);
    return result;
  }

  async function input(
    id: string,
    body: { input: string; inputId?: string; attachments?: { path: string; name?: string }[] },
  ) {
    return withReceipt(id, body.inputId, (send, record) => inputOnce(id, body, send, record));
  }

  return { input, changeAccount };
}
