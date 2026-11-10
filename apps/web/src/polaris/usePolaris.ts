import { useEffect, useState } from "react";
import { freshAccess, type PolarisAccess } from "./state";
import { withDeviceHubQuery } from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  EventParser,
  request,
  type BriefData,
  type Bridge,
  type Lease,
  type Port,
  type Project,
  type Run,
  type Stream,
  type Tunnel,
} from "./api";

export interface Data {
  runs: Run[];
  projects: Project[];
  ports: Port[];
  tunnels: Tunnel[];
  leases: Lease[];
  streams: Stream[];
  bridges: Bridge[];
  brief: BriefData;
}
const paths = {
  runs: "/v0/runs",
  projects: "/v0/projects",
  ports: "/v0/ports",
  tunnels: "/v0/tunnels",
  leases: "/v0/devices/simulators/leases",
  streams: "/v0/devices/simulator-streams",
  bridges: "/v0/discord/bridges",
  brief: "/v0/brief",
} as const;
type Collection = keyof Data;
function streamReader(response: Response) {
  if (!response.ok || !response.body) throw new Error(`Stream: ${response.status}`);
  return response.body.getReader();
}
export function usePolaris(access: PolarisAccess | null) {
  const [stored, setData] = useState<{ id: string; data: Data } | null>(null);
  const [failure, setError] = useState<{ id: string; message: string } | null>(null);
  const data = stored && stored.id === access?.environmentId ? stored.data : null;
  const error = failure && failure.id === access?.environmentId ? failure.message : null;
  const [revision, setRevision] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the daemon and cleans up the stream and timers
  useEffect(() => {
    if (!access) return;
    const controller = new AbortController();
    const parser = new EventParser();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    const pending = new Set<Collection>();
    const refresh = async (keys: Collection[]) => {
      try {
        const pairs = await Promise.all(
          keys.map(async (key) => {
            const result = await request<Record<string, unknown>>(access, paths[key], {
              signal: controller.signal,
            });
            return [key, key === "brief" ? result : (result[key] ?? [])] as const;
          }),
        );
        if (!controller.signal.aborted) {
          setData((old) => ({
            id: access.environmentId,
            data: {
              ...(old?.id === access.environmentId
                ? old.data
                : {
                    runs: [],
                    projects: [],
                    ports: [],
                    tunnels: [],
                    leases: [],
                    streams: [],
                    bridges: [],
                    brief: { enabled: false, runs: [] },
                  }),
              ...Object.fromEntries(pairs),
            } as Data,
          }));
          setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError({
            id: access.environmentId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
      }
    };
    const all = () => void refresh(Object.keys(paths) as Collection[]);
    const onEvent = (type: string) => {
      const key: Collection[] = type.startsWith("brief.")
        ? ["brief"]
        : type.startsWith("run.") ||
            type.startsWith("session.") ||
            type.startsWith("assistant.") ||
            type.startsWith("pane.") ||
            type.startsWith("tmux.") ||
            type.startsWith("claude.") ||
            type.startsWith("user.")
          ? ["runs"]
          : type.startsWith("port.")
            ? ["ports"]
            : type.startsWith("tunnel.")
              ? ["tunnels"]
              : type.includes("simulator") || type.includes("device")
                ? ["leases", "streams"]
                : type.startsWith("discord.")
                  ? ["bridges"]
                  : type.startsWith("project.")
                    ? ["projects"]
                    : [];
      key.forEach((item) => pending.add(item));
      if (pending.size) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const keys = [...pending];
          pending.clear();
          void refresh(keys);
        }, 250);
      }
    };
    const connect = async () => {
      try {
        const auth = await freshAccess(access);
        const url = withDeviceHubQuery(
          `${auth.httpBase}/v0/events/stream?after=${parser.lastId}`,
          auth,
        );
        const response = await fetch(url, {
          credentials: auth.credentials ? "include" : "same-origin",
          signal: controller.signal,
        });
        const reader = streamReader(response);
        parser.resetFrame();
        const decoder = new TextDecoder();
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          retry = 0;
          for (const event of parser.push(decoder.decode(chunk.value, { stream: true })))
            onEvent(event.type);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError({
            id: access.environmentId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
      }
      if (!controller.signal.aborted) {
        const delay =
          Math.min(30_000, 500 * 2 ** Math.min(retry, 6)) * (0.75 + Math.random() * 0.5);
        retry = retry + 1;
        reconnect = setTimeout(() => void connect(), delay);
      }
    };
    all();
    void connect();
    const interval = setInterval(all, 30_000);
    window.addEventListener("focus", all);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(reconnect);
      clearInterval(interval);
      window.removeEventListener("focus", all);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- revision explicitly restarts the subscription on refresh
  }, [access, revision]);
  return { data, error, refresh: () => setRevision((n) => n + 1) };
}
