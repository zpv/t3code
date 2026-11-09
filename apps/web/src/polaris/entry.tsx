import { useNavigate } from "@tanstack/react-router";
import { OrbitIcon } from "lucide-react";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { useAvailability, usePolarisAccess } from "./state";

export function PolarisSidebarButton() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const available = useAvailability(usePolarisAccess(usePrimaryEnvironmentId()));
  if (!available) return null;
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label="Polaris"
              size="icon"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                sessionStorage.setItem("polaris-return", location.pathname + location.search);
                void navigate({ href: "/polaris" });
              }}
            >
              <OrbitIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Polaris</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
export function usePolarisPaletteItems(): CommandPaletteActionItem[] {
  const navigate = useNavigate();
  const available = useAvailability(usePolarisAccess(usePrimaryEnvironmentId()));
  if (!available) return [];
  return [
    ["Open Polaris", "/polaris"],
    ["Polaris: Move runs to T3…", "/polaris?migrate=1"],
    ["Polaris: Ports and tunnels", "/polaris?tab=resources"],
  ].map(([title, href]) => ({
    kind: "action" as const,
    value: `action:polaris:${href}`,
    title,
    searchTerms: ["polaris"],
    icon: <OrbitIcon className="size-4" />,
    run: async () => {
      sessionStorage.setItem("polaris-return", location.pathname + location.search);
      await navigate({ href: href! });
    },
  }));
}
