import { useAtomValue } from "@effect/atom-react";
import {
  resolveDeviceHubAccess,
  type DeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useEffect, useState } from "react";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";
import { request } from "./api";

export type PolarisAccess = DeviceHubAccess & { environmentId: EnvironmentId };
const makeAccessAtom = () =>
  Atom.family((id: EnvironmentId) =>
    connectionAtomRuntime
      .atom((get) => {
        const prepared = Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(id)));
        return prepared
          ? resolveDeviceHubAccess({ prepared, hubBasePath: "/api/polaris/proxy" }).pipe(
              Effect.map((access) => ({ ...access, environmentId: id })),
            )
          : Effect.never;
      })
      .pipe(Atom.setIdleTTL(60_000)),
  );
const accessAtom = makeAccessAtom();
const requestAccessAtom = makeAccessAtom();
export function readPolarisAccess(id: EnvironmentId): Promise<PolarisAccess> {
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, requestAccessAtom(id), { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
    ),
  );
}
const emptyAtom = Atom.make(AsyncResult.initial<PolarisAccess, never>());
export function usePolarisAccess(id: EnvironmentId | null) {
  const result = useAtomValue(id ? accessAtom(id) : emptyAtom);
  return AsyncResult.isSuccess(result) ? result.value : null;
}
const tickets = new Map<EnvironmentId, { until: number; value: Promise<PolarisAccess> }>();
export function freshAccess(access: PolarisAccess): Promise<PolarisAccess> {
  if (access.credentials) return Promise.resolve(access);
  const existing = tickets.get(access.environmentId);
  if (existing && existing.until > Date.now()) return existing.value;
  const atom = requestAccessAtom(access.environmentId);
  appAtomRegistry.refresh(atom);
  const value = Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
    ),
  );
  tickets.set(access.environmentId, { until: Date.now() + 60_000, value });
  void value.catch(() => {
    if (tickets.get(access.environmentId)?.value === value) tickets.delete(access.environmentId);
  });
  return value;
}
export function useAvailability(access: PolarisAccess | null) {
  const [state, setState] = useState<{ id: EnvironmentId; available: boolean } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- checks an external daemon while the entry point is mounted
  useEffect(() => {
    if (!access) return;
    let live = true;
    const check = () =>
      void request(access, "/v0/health").then(
        () => {
          if (live) setState({ id: access.environmentId, available: true });
        },
        () => {
          if (live) setState({ id: access.environmentId, available: false });
        },
      );
    check();
    const timer = setInterval(check, 30_000);
    window.addEventListener("focus", check);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [access]);
  return access !== null && state?.id === access.environmentId && state.available;
}
