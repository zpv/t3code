# Polaris fork seams

| File                                                | Marker                                | Reason                             |
| --------------------------------------------------- | ------------------------------------- | ---------------------------------- |
| `apps/server/src/server.ts`                         | `polaris-fork: proxy import`          | Import the polarisd proxy route.   |
| `apps/server/src/server.ts`                         | `polaris-fork: proxy route`           | Register the polarisd proxy route. |
| `apps/server/src/server.ts`                         | `polaris-fork: import session import` | Import the native session route.   |
| `apps/server/src/server.ts`                         | `polaris-fork: import session route`  | Register the native session route. |
| `apps/web/src/components/sidebar/SidebarChrome.tsx` | `polaris-fork: sidebar import`        | Show the Polaris entry.            |
| `apps/web/src/components/CommandPalette.tsx`        | `polaris-fork: palette import`        | Add Polaris commands.              |

| `apps/web/src/components/sidebar/SidebarChrome.tsx` | `polaris-fork: sidebar button` | Show the Polaris entry. |
| `apps/web/src/components/CommandPalette.tsx` | `polaris-fork: palette items` | Add Polaris commands. |
| `apps/web/src/routes/__root.tsx` | `polaris-fork: sound host import` | Import the headless sound host. |
| `apps/web/src/routes/__root.tsx` | `polaris-fork: sound host` | Mount the headless sound host. |
| `apps/web/src/hooks/useThreadActions.ts` | `polaris-fork: worktree guard import` | Import the worktree ownership guard. |
| `apps/web/src/hooks/useThreadActions.ts` | `polaris-fork: worktree guard` | Guard worktree removal on thread deletion. |
| `scripts/build-desktop-artifact.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `scripts/build-desktop-artifact.ts` | `polaris-fork: artifact id` | Fork identity and deep-link integration. |
| `scripts/build-desktop-artifact.ts` | `polaris-fork: artifact product` | Fork identity and deep-link integration. |
| `scripts/build-desktop-artifact.ts` | `polaris-fork: artifact name` | Fork identity and deep-link integration. |
| `scripts/build-desktop-artifact.ts` | `polaris-fork: release source` | Fork identity and deep-link integration. |
| `scripts/build-desktop-artifact.ts` | `polaris-fork: disable release feed` | Fork identity and deep-link integration. |
| `scripts/build-desktop-artifact.ts` | `polaris-fork: mac schemes` | Fork identity and deep-link integration. |
| `scripts/build-desktop-artifact.ts` | `polaris-fork: linux schemes` | Fork identity and deep-link integration. |
| `apps/desktop/src/electron/ElectronProtocol.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/desktop/src/electron/ElectronProtocol.ts` | `polaris-fork: production scheme` | Fork identity and deep-link integration. |
| `apps/desktop/src/electron/ElectronProtocol.ts` | `polaris-fork: development scheme` | Fork identity and deep-link integration. |
| `apps/desktop/src/app/DesktopUserData.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/desktop/src/app/DesktopUserData.ts` | `polaris-fork: user data names` | Fork identity and deep-link integration. |
| `apps/desktop/src/app/DesktopUserData.ts` | `polaris-fork: credential isolation` | Fork identity and deep-link integration. |
| `apps/desktop/src/app/DesktopEnvironment.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/desktop/src/app/DesktopEnvironment.ts` | `polaris-fork: app name` | Fork identity and deep-link integration. |
| `apps/desktop/src/app/DesktopEnvironment.ts` | `polaris-fork: desktop home` | Fork identity and deep-link integration. |
| `apps/desktop/src/app/DesktopEnvironment.ts` | `polaris-fork: app model id` | Fork identity and deep-link integration. |
| `apps/desktop/src/app/DesktopClerk.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/desktop/src/app/DesktopClerk.ts` | `polaris-fork: deep link dispatch` | Fork identity and deep-link integration. |
| `apps/desktop/src/updates/DesktopUpdates.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/desktop/src/updates/DesktopUpdates.ts` | `polaris-fork: update default` | Fork identity and deep-link integration. |
| `apps/server/src/httpCors.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/server/src/httpCors.ts` | `polaris-fork: cors origins` | Fork identity and deep-link integration. |
| `apps/server/src/os-jank.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/server/src/os-jank.ts` | `polaris-fork: server home` | Fork identity and deep-link integration. |
| `apps/server/src/telemetry/AnalyticsService.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/server/src/telemetry/AnalyticsService.ts` | `polaris-fork: telemetry default` | Fork identity and deep-link integration. |
| `apps/server/src/telemetry/AnalyticsService.ts` | `polaris-fork: shell telemetry default` | Fork identity and deep-link integration. |
| `apps/web/src/branding.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/web/src/branding.ts` | `polaris-fork: web name` | Fork identity and deep-link integration. |
| `apps/web/src/components/desktop/DesktopWebLinkCoordinator.tsx` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `apps/web/src/components/desktop/DesktopWebLinkCoordinator.tsx` | `polaris-fork: deep link navigation` | Fork identity and deep-link integration. |
| `packages/shared/src/remote.ts` | `polaris-fork: identity import` | Fork identity and deep-link integration. |
| `packages/shared/src/remote.ts` | `polaris-fork: identity exports` | Fork identity and deep-link integration. |
| `packages/shared/src/remote.ts` | `polaris-fork: pairing protocols` | Fork identity and deep-link integration. |
| `packages/shared/src/remote.ts` | `polaris-fork: pairing scheme` | Fork identity and deep-link integration. |
