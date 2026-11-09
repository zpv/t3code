import { freshAccess, type PolarisAccess } from "./state";
import { withDeviceHubQuery } from "@t3tools/client-runtime/state/deviceHubAccess";

export interface Run {
  id: string;
  name: string;
  agent: string;
  backend?: string;
  projectId?: string;
  status: string;
  turnState?: string;
  model?: string;
  branch?: string;
  updatedAt: string;
  t3ThreadId?: string;
  t3EnvironmentId?: string;
  t3Link?: string;
}
export interface Project {
  id: string;
  name: string;
}
export interface Port {
  id: string;
  port: number;
  purpose: string;
  runId?: string;
  status: string;
  createdAt: string;
}
export interface Tunnel {
  id: string;
  provider: string;
  localPort: number;
  publicUrl?: string;
  status: string;
}
export interface Lease {
  id: string;
  name: string;
  runtime?: string;
  runId?: string;
  status: string;
  createdAt: string;
}
export interface Stream {
  id: string;
  simulatorLeaseId: string;
  status: string;
  viewUrl?: string;
  url?: string;
}
export interface Bridge {
  runId: string;
  guildId: string;
  threadId?: string;
}
export interface MigrationRow {
  runId: string;
  name: string;
  projectId?: string;
  agent: string;
  action: string;
  reason?: string;
  link?: string;
  threadId?: string;
}
export interface Migration {
  results: MigrationRow[];
}

export function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const value = body as Record<string, unknown>;
    for (const key of ["error", "reason", "stderr"])
      if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return fallback;
}
export async function request<T>(
  access: PolarisAccess,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const auth = await freshAccess(access);
  const response = await fetch(withDeviceHubQuery(`${auth.httpBase}${path}`, auth), {
    cache: "no-store",
    credentials: auth.credentials ? "include" : "same-origin",
    ...options,
  });
  const body: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    (body &&
      typeof body === "object" &&
      (("ok" in body && body.ok === false) ||
        (options.method === "POST" &&
          "stderr" in body &&
          typeof body.stderr === "string" &&
          body.stderr.length > 0)))
  )
    throw new Error(errorMessage(body, `${response.status} ${response.statusText}`));
  return body as T;
}
export function post<T>(
  access: PolarisAccess,
  path: string,
  body: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  return request(access, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

export interface StreamEvent {
  id: number;
  type: string;
  data: string;
}
export class EventParser {
  private buffer = "";
  lastId = 0;
  resetFrame() {
    this.buffer = "";
  }
  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    this.buffer = this.buffer.replace(/\r\n/g, "\n");
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop() ?? "";
    return frames.flatMap((frame) => {
      let id = 0,
        type = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        const index = line.indexOf(":");
        const key = index < 0 ? line : line.slice(0, index);
        const value = index < 0 ? "" : line.slice(index + 1).replace(/^ /, "");
        if (key === "id") id = Number(value);
        else if (key === "event") type = value;
        else if (key === "data") data.push(value);
      }
      if (!id || id <= this.lastId || !data.length) return [];
      this.lastId = id;
      return [{ id, type, data: data.join("\n") }];
    });
  }
}
