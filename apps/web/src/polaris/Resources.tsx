import type { ReactNode } from "react";
import type { PolarisAccess } from "./state";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { mutate, relativeTime } from "./actions";
import type { Data } from "./usePolaris";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      <div className="overflow-hidden rounded-lg border">{children}</div>
    </section>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-muted-foreground">{children}</p>;
}
function Owner({
  id,
  data,
  onRun,
}: {
  id: string | undefined;
  data: Data;
  onRun: (id: string) => void;
}) {
  const run = data.runs.find((r) => r.id === id);
  return run ? (
    <button
      type="button"
      className="truncate text-left underline-offset-2 hover:underline"
      onClick={() => onRun(run.id)}
    >
      {run.name}
    </button>
  ) : (
    <span>-</span>
  );
}
function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-sm last:border-0">
      {children}
    </div>
  );
}
export function Resources({
  data,
  access,
  refresh,
  onRun,
}: {
  data: Data;
  access: PolarisAccess;
  refresh: () => void;
  onRun: (id: string) => void;
}) {
  const ports = data.ports.filter((p) => p.status !== "released");
  const tunnels = data.tunnels.filter((t) => t.status !== "stopped");
  return (
    <div className="space-y-8">
      <Section title="Ports">
        {ports.length ? (
          ports.map((port) => (
            <Row key={port.id}>
              <span className="font-mono tabular-nums">{port.port}</span>
              <span className="min-w-32 flex-1 truncate">{port.purpose}</span>
              <span className="text-muted-foreground">
                <Owner id={port.runId} data={data} onRun={onRun} />
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {relativeTime(port.createdAt)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void mutate(
                    access,
                    `/v0/ports/${port.id}/release`,
                    "Port released",
                    refresh,
                    {},
                    `Release port ${port.port}?`,
                  )
                }
              >
                Release
              </Button>
            </Row>
          ))
        ) : (
          <Empty>No ports reserved.</Empty>
        )}
      </Section>
      <Section title="Tunnels">
        {tunnels.length ? (
          tunnels.map((tunnel) => (
            <Row key={tunnel.id}>
              <span>{tunnel.provider}</span>
              <span className="font-mono tabular-nums">{tunnel.localPort}</span>
              <span className="min-w-32 flex-1 truncate">
                {tunnel.publicUrl ? (
                  <a
                    href={tunnel.publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline-offset-2 hover:underline"
                  >
                    {tunnel.publicUrl}
                  </a>
                ) : (
                  "-"
                )}
              </span>
              {tunnel.publicUrl ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy tunnel URL"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(tunnel.publicUrl!)
                      .then(() => toastManager.add({ type: "success", title: "URL copied" }))
                  }
                >
                  <CopyIcon />
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">{tunnel.status}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void mutate(
                    access,
                    `/v0/tunnels/${tunnel.id}/stop`,
                    "Tunnel stopped",
                    refresh,
                    {},
                    "Stop this tunnel?",
                  )
                }
              >
                Stop
              </Button>
            </Row>
          ))
        ) : (
          <Empty>No tunnels.</Empty>
        )}
      </Section>
    </div>
  );
}
export function Devices({
  data,
  access,
  refresh,
  onRun,
}: {
  data: Data;
  access: PolarisAccess;
  refresh: () => void;
  onRun: (id: string) => void;
}) {
  const leases = data.leases.filter((l) => l.status !== "released");
  return (
    <Section title="Simulators">
      {leases.length ? (
        leases.map((lease) => {
          const stream = data.streams.find(
            (s) => s.simulatorLeaseId === lease.id && s.status !== "stopped",
          );
          const url = stream?.viewUrl ?? stream?.url;
          return (
            <Row key={lease.id}>
              <span className="min-w-32 flex-1 truncate font-medium">{lease.name}</span>
              <span className="text-muted-foreground">{lease.runtime}</span>
              <span className="text-muted-foreground">
                <Owner id={lease.runId} data={data} onRun={onRun} />
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {relativeTime(lease.createdAt)}
              </span>
              {stream && url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                >
                  Open viewer <ExternalLinkIcon className="size-3" />
                </a>
              ) : null}
              {stream ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void mutate(
                      access,
                      `/v0/devices/simulator-streams/${stream.id}/stop`,
                      "Stream stopped",
                      refresh,
                      {},
                      "Stop this stream?",
                    )
                  }
                >
                  Stop stream
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void mutate(
                    access,
                    `/v0/devices/simulators/leases/${lease.id}/release`,
                    "Simulator released",
                    refresh,
                    {},
                    "Release this simulator? This also stops its stream.",
                  )
                }
              >
                Release
              </Button>
            </Row>
          );
        })
      ) : (
        <Empty>No simulators reserved.</Empty>
      )}
    </Section>
  );
}
