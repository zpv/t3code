// @effect-diagnostics globalFetch:off globalTimers:off globalRandom:off globalConsole:off globalJsonInEffect:off -- The bridge owns its HTTP retry lifecycle.
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const log = (s: string) => console.error(`[polaris-bridge] ${s.slice(0, 300)}`);
export async function postPolaris(
  polaris: string,
  pathname: string,
  body: object,
): Promise<unknown> {
  let backoff = 250;
  for (;;) {
    try {
      const res = await fetch(polaris + pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json();
      if (res.status < 500) {
        log(`polaris ${pathname}: ${res.status}, dropped`);
        return null;
      }
      log(`polaris ${pathname}: ${res.status}, retrying`);
    } catch (error) {
      log(`polaris ${pathname}: ${String(error)}, retrying`);
    }
    await delay(backoff + (Math.random() * backoff) / 4);
    backoff = Math.min(backoff * 2, 30_000);
  }
}
