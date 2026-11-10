export const FORK_IDENTITY = {
  productName: "Polaris",
  appId: "sh.zpv.polaris.t3",
  devAppId: "sh.zpv.polaris.t3.dev",
  scheme: "polaris-t3",
  devScheme: "polaris-t3-dev",
  userData: "polaris-t3",
  devUserData: "polaris-t3-dev",
  home: ".polaris-t3",
  telemetryEnabled: false,
  autoUpdateEnabled: false,
  releaseSource: null,
} as const;

export function forkLinkPath(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (
    ![`${FORK_IDENTITY.scheme}:`, `${FORK_IDENTITY.devScheme}:`].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  if (url.hostname === "app") {
    if (
      url.pathname !== "/welcome" &&
      url.pathname !== "/settings" &&
      !url.pathname.startsWith("/settings/")
    )
      return null;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      )
        url.searchParams.delete(key);
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/.test(url.hash)) url.hash = "";
    return `${url.pathname}${url.search}${url.hash}`;
  }
  if (url.search || url.hash) return null;
  if (url.hostname === "polaris" && (url.pathname === "" || url.pathname === "/"))
    return "/polaris";
  if (url.hostname !== "thread" || !/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))
    return null;
  return url.pathname;
}
