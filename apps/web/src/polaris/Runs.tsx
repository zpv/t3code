import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { PolarisAccess } from "./state";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  ArrowRightLeftIcon,
  PlayIcon,
  SmartphoneIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import { ClaudeAI, OpenAI } from "~/components/Icons";
import { DiscordIcon } from "./DiscordIcon";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { toastManager } from "~/components/ui/toast";
import { post, request, type Run } from "./api";
import { mutate, relativeTime } from "./actions";
import { groupRuns, runState } from "./logic";
import type { Data } from "./usePolaris";

export function Runs({
  data,
  access,
  initialRunId,
  environmentId,
  onMigrate,
  refresh,
}: {
  data: Data;
  access: PolarisAccess;
  initialRunId: string | null;
  environmentId: EnvironmentId;
  onMigrate: (id: string | null) => void;
  refresh: () => void;
}) {
  const [search, setSearch] = useState(initialRunId ?? "");
  const [active, setActive] = useState(initialRunId === null);
  const groups = groupRuns(data.runs, data.projects, search, active);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Search runs"
          placeholder="Search runs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-72"
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={active} onCheckedChange={setActive} size="sm" />
          Active only
        </label>
        {data.runs.some(
          (r) => r.backend !== "t3" && (r.agent === "claude" || r.agent === "codex"),
        ) ? (
          <Button variant="outline" size="sm" className="ms-auto" onClick={() => onMigrate(null)}>
            Move to T3…
          </Button>
        ) : null}
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs found.</p>
      ) : (
        groups.map((group) => (
          <section key={group.name} className="space-y-2">
            <h2 className="text-sm font-medium">
              {group.name} <span className="text-muted-foreground">{group.runs.length}</span>
            </h2>
            <div className="overflow-hidden rounded-lg border">
              {group.runs.map((run, index) => (
                <div key={run.id}>
                  {run.agent === "shell" &&
                  (index === 0 || group.runs[index - 1]?.agent !== "shell") ? (
                    <div className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                      Services
                    </div>
                  ) : null}
                  <RunRow
                    run={run}
                    data={data}
                    access={access}
                    environmentId={environmentId}
                    onMigrate={onMigrate}
                    refresh={refresh}
                  />
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
function RunRow({
  run,
  data,
  access,
  environmentId,
  onMigrate,
  refresh,
}: {
  run: Run;
  data: Data;
  access: PolarisAccess;
  environmentId: EnvironmentId;
  onMigrate: (id: string | null) => void;
  refresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const state = runState(run);
  const bridge = data.bridges.find((b) => b.runId === run.id && b.threadId && b.guildId);
  const threadHref = `/${encodeURIComponent(run.t3EnvironmentId || environmentId)}/${encodeURIComponent(run.t3ThreadId || "")}`;
  const open = () => void navigate({ href: threadHref });
  const stop = () =>
    void mutate(
      access,
      `/v0/runs/${encodeURIComponent(run.id)}/stop`,
      "Run stopped",
      refresh,
      {},
      `Stop ${run.name}?`,
    );
  const resume = () =>
    void mutate(access, `/v0/runs/${encodeURIComponent(run.id)}/resume`, "Run resumed", refresh);
  const phone = () =>
    void mutate(access, "/v0/notifications/phone", "Link sent to phone", refresh, {
      kind: "link",
      url: new URL(threadHref, window.location.origin).href,
    });
  const copy = () =>
    void navigator.clipboard
      .writeText(run.id)
      .then(() => toastManager.add({ type: "success", title: "Run ID copied" }));
  return (
    <>
      <div
        id={`run-${run.id}`}
        className="group flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-sm last:border-b-0"
      >
        {run.agent === "shell" ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${run.name}`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={state}
                className={`size-2 shrink-0 rounded-full ${state === "working" ? "bg-primary motion-safe:animate-pulse" : state === "waiting" ? "bg-warning-foreground" : state === "failed" ? "bg-destructive" : state === "stopped" ? "border border-muted-foreground" : "bg-muted-foreground/50"}`}
              />
            }
          />
          <TooltipPopup>{state}</TooltipPopup>
        </Tooltip>
        <span className="min-w-24 flex-1 truncate font-medium">{run.name}</span>
        <span className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground max-md:order-last max-md:w-full max-md:ps-5">
          {run.agent === "shell" ? (
            <TerminalIcon className="size-4 shrink-0" />
          ) : run.agent === "claude" ? (
            <ClaudeAI className="size-4 shrink-0 fill-current" />
          ) : (
            <OpenAI className="size-4 shrink-0" />
          )}
          <span className="md:w-9">{run.backend === "t3" ? "T3" : "tmux"}</span>
          <span className="max-w-36 truncate md:w-36">{run.model}</span>
          <span className="max-w-36 truncate md:w-44 md:max-w-44">{run.branch}</span>
          <span className="whitespace-nowrap tabular-nums md:w-16 md:text-right">
            {relativeTime(run.updatedAt)}
          </span>
        </span>
        {bridge ? (
          <a
            href={`https://discord.com/channels/${bridge.guildId}/${bridge.threadId}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open Discord for ${run.name}`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            <DiscordIcon />
          </a>
        ) : null}
        <div className="hidden items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 md:flex">
          {run.backend === "t3" && run.t3ThreadId ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Open thread for ${run.name}`}
              onClick={open}
            >
              <ExternalLinkIcon />
            </Button>
          ) : null}
          {run.status === "stopped" ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Resume ${run.name}`}
              onClick={resume}
            >
              <PlayIcon />
            </Button>
          ) : (
            <Button variant="ghost" size="icon-xs" aria-label={`Stop ${run.name}`} onClick={stop}>
              <SquareIcon />
            </Button>
          )}
          {run.backend !== "t3" && (run.agent === "claude" || run.agent === "codex") ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${run.name} to T3`}
              onClick={() => onMigrate(run.id)}
            >
              <ArrowRightLeftIcon />
            </Button>
          ) : null}
          {run.backend === "t3" && run.t3ThreadId ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Send link to phone for ${run.name}`}
              onClick={phone}
            >
              <SmartphoneIcon />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Copy run ID for ${run.name}`}
            onClick={copy}
          >
            <CopyIcon />
          </Button>
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${run.name}`} />
            }
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {run.backend === "t3" && run.t3ThreadId ? (
              <>
                <MenuItem onClick={open}>Open thread</MenuItem>
                <MenuItem onClick={phone}>
                  <SmartphoneIcon />
                  Send link to phone
                </MenuItem>
              </>
            ) : null}
            {run.status === "stopped" ? (
              <MenuItem onClick={resume}>Resume</MenuItem>
            ) : (
              <MenuItem onClick={stop}>Stop</MenuItem>
            )}
            {run.backend !== "t3" && (run.agent === "claude" || run.agent === "codex") ? (
              <MenuItem onClick={() => onMigrate(run.id)}>Move to T3</MenuItem>
            ) : null}
            <MenuItem onClick={copy}>
              <CopyIcon />
              Copy run ID
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {expanded && run.agent === "shell" ? <Peek run={run} access={access} /> : null}
    </>
  );
}
function Peek({ run, access }: { run: Run; access: PolarisAccess }) {
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the terminal snapshot scrolled to its latest output
  useEffect(() => {
    if (output && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the external tmux snapshot while expanded
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      void request<{ output: string }>(
        access,
        `/v0/runs/${encodeURIComponent(run.id)}/snapshot?lines=120`,
        { signal: controller.signal },
      ).then(
        (result) => setOutput(result.output),
        () => {},
      );
    load();
    const timer = setInterval(load, 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [access, run.id]);
  const send = async () => {
    if (!input || pending) return;
    setPending(true);
    try {
      await post(access, `/v0/runs/${encodeURIComponent(run.id)}/input`, { input });
      setInput("");
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Input failed",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
    setPending(false);
  };
  return (
    <div className="space-y-2 border-b bg-muted/20 p-3">
      <pre
        ref={outputRef}
        className="h-64 overflow-auto rounded-md bg-background p-3 font-mono text-xs whitespace-pre-wrap"
      >
        {output}
      </pre>
      <Input
        aria-label={`Input for ${run.name}`}
        placeholder={pending ? "Sending…" : "Send input…"}
        value={input}
        disabled={pending}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void send();
        }}
      />
    </div>
  );
}
