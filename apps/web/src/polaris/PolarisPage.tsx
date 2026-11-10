import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { ChevronDownIcon, MoreHorizontalIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Button, InlineButton } from "~/components/ui/button";
import { DialogBackdrop } from "~/components/ui/dialog";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { ThreadRouteView } from "~/components/ThreadRouteView";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { usePolarisAccess } from "./state";
import { usePolaris } from "./usePolaris";
import { Runs } from "./Runs";
import { Resources, Devices } from "./Resources";
import { Brief } from "./Brief";
import { playSound, useSoundSettings } from "./sound";
import { MigrationDialog } from "./MigrationDialog";

export function PolarisPage() {
  const navigate = useNavigate();
  const sound = useSoundSettings();
  const [background] = useState(() => {
    const pathname = (sessionStorage.getItem("polaris-return") ?? "").split("?")[0] ?? "";
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 2) return null;
    return parts[0] === "draft"
      ? resolveThreadRouteTarget({ draftId: parts[1] })
      : resolveThreadRouteTarget({ environmentId: parts[0], threadId: parts[1] });
  });
  const location = useLocation();
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const id = selected ?? primary;
  const access = usePolarisAccess(id);
  const { data, error, refresh } = usePolaris(access);
  const params = new URLSearchParams(location.searchStr);
  const tab = ["runs", "resources", "devices", "brief"].includes(params.get("tab") ?? "")
    ? params.get("tab")!
    : "runs";
  const [migration, setMigration] = useState<string | null | false>(() =>
    params.has("migrate") ? null : false,
  );
  const environment = environments.find((item) => item.environmentId === id);
  const selectTab = (next: string) => {
    params.set("tab", next);
    params.delete("migrate");
    params.delete("run");
    void navigate({ href: `/polaris?${params.toString()}`, replace: true });
  };
  const openRun = (runId: string) => {
    params.set("tab", "runs");
    params.set("run", runId);
    void navigate({ href: `/polaris?${params.toString()}`, replace: true });
  };
  const close = () => {
    void navigate({ href: sessionStorage.getItem("polaris-return") || "/", replace: true });
  };
  return (
    <>
      {background ? <ThreadRouteView target={background} background /> : null}
      <DialogPrimitive.Root
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPrimitive.Portal>
          <DialogBackdrop />
          <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center sm:p-6 lg:p-10">
            <DialogPrimitive.Popup
              aria-label="Polaris"
              className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground outline-none sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
            >
              <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b ps-5 pe-2 py-2">
                <WorkspaceBreadcrumb
                  ariaLabel="Polaris breadcrumb"
                  className="min-w-0 flex-1 max-md:order-1 max-md:basis-[calc(100%-5rem)]"
                >
                  <WorkspaceBreadcrumbItem>
                    <h1>Polaris</h1>
                  </WorkspaceBreadcrumbItem>
                  <WorkspaceBreadcrumbSeparator />
                  <WorkspaceBreadcrumbItem current className="min-w-10 shrink">
                    {environments.length > 1 ? (
                      <Menu>
                        <MenuTrigger render={<InlineButton />}>
                          <WorkspaceBreadcrumbText>
                            {environment?.label ?? "Environment"}
                          </WorkspaceBreadcrumbText>
                          <ChevronDownIcon className="size-3.5" />
                        </MenuTrigger>
                        <MenuPopup align="start">
                          {environments.map((item) => (
                            <MenuItem
                              key={item.environmentId}
                              onClick={() => setSelected(item.environmentId)}
                            >
                              {item.label}
                            </MenuItem>
                          ))}
                        </MenuPopup>
                      </Menu>
                    ) : (
                      <WorkspaceBreadcrumbText>
                        {environment?.label ?? "Environment"}
                      </WorkspaceBreadcrumbText>
                    )}
                  </WorkspaceBreadcrumbItem>
                </WorkspaceBreadcrumb>
                <ToggleGroup
                  className="max-md:order-4"
                  aria-label="Polaris sections"
                  variant="segmented"
                  value={[tab]}
                  onValueChange={(next) => {
                    if (next[0]) selectTab(next[0]);
                  }}
                >
                  {["runs", "resources", "devices", "brief"].map((value) => (
                    <Toggle key={value} value={value}>
                      {value[0]!.toUpperCase() + value.slice(1)}
                    </Toggle>
                  ))}
                </ToggleGroup>
                <Menu>
                  <MenuTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label="Polaris settings" />}
                  >
                    <MoreHorizontalIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuCheckboxItem checked={sound.enabled} onCheckedChange={sound.setEnabled}>
                      Completion sound
                    </MenuCheckboxItem>
                    {[1, 2, 3].map((volume) => (
                      <MenuCheckboxItem
                        key={volume}
                        checked={sound.volume === volume}
                        onCheckedChange={() => sound.setVolume(volume)}
                      >
                        Volume {volume}
                      </MenuCheckboxItem>
                    ))}
                    <MenuItem onClick={() => playSound("completion", true)}>Test sound</MenuItem>
                  </MenuPopup>
                </Menu>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="max-md:order-2"
                  aria-label="Refresh Polaris"
                  onClick={refresh}
                >
                  <RefreshCwIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className="max-md:order-3"
                  onClick={close}
                >
                  <XIcon />
                </Button>
              </header>
              <ScrollArea className="min-h-0 flex-1">
                <WorkspacePageContainer width="wide">
                  {error && data ? (
                    <div className="mb-4 flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                      <span>Polaris unavailable: {error}</span>
                      <Button variant="outline" size="sm" onClick={refresh}>
                        Retry
                      </Button>
                    </div>
                  ) : null}
                  {!data && error ? (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                      This environment has no Polaris daemon.{" "}
                      <Button variant="ghost" size="sm" onClick={refresh}>
                        Retry
                      </Button>
                    </div>
                  ) : !data || !access || !id ? (
                    <div className="space-y-2">
                      {[1, 2, 3, 4].map((n) => (
                        <Skeleton key={n} className="h-10 w-full" />
                      ))}
                    </div>
                  ) : (
                    <div className={error ? "opacity-50" : undefined}>
                      {tab === "runs" ? (
                        <Runs
                          data={data}
                          access={access}
                          initialRunId={params.get("run")}
                          environmentId={id}
                          onMigrate={setMigration}
                          refresh={refresh}
                        />
                      ) : tab === "resources" ? (
                        <Resources data={data} access={access} refresh={refresh} onRun={openRun} />
                      ) : tab === "devices" ? (
                        <Devices data={data} access={access} refresh={refresh} onRun={openRun} />
                      ) : (
                        <Brief
                          brief={data.brief}
                          data={data}
                          access={access}
                          refresh={refresh}
                          onRun={openRun}
                        />
                      )}
                    </div>
                  )}
                </WorkspacePageContainer>
              </ScrollArea>
              {migration !== false && access && data ? (
                <MigrationDialog
                  access={access}
                  environmentId={id!}
                  projects={data.projects}
                  runId={migration}
                  onClose={() => setMigration(false)}
                  refresh={refresh}
                />
              ) : null}
            </DialogPrimitive.Popup>
          </DialogPrimitive.Viewport>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
