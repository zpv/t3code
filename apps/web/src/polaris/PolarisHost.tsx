import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { isListedThreadLineage } from "@t3tools/contracts";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { liveShellEnvironmentIdsAtom } from "~/state/shell";
import { environmentThreadShells } from "~/state/threads";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "~/threadRoutes";
import { useComposerDraftStore } from "~/composerDraftStore";
import { cueForTransition, playSound, unlockSound, type SoundState } from "./sound";

export function PolarisHost() {
  const router = useRouter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to shell state and browser gesture events for audio notifications
  useEffect(() => {
    let previous = new Map<string, SoundState>();
    let previousLive = new Set<string>();
    let lastPlayed = 0;
    const update = () => {
      const live = appAtomRegistry.get(liveShellEnvironmentIdsAtom);
      const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
      const draft =
        target?.kind === "draft"
          ? useComposerDraftStore.getState().getDraftSession(target.draftId)
          : null;
      const open = resolveActiveThreadRouteRef(target, draft);
      const openKey = open ? scopedThreadKey(open) : null;
      const next = new Map<string, SoundState>();
      for (const thread of appAtomRegistry.get(environmentThreadShells.quietThreadShellsAtom)) {
        if (
          !live.has(thread.environmentId) ||
          !isListedThreadLineage(thread.lineage) ||
          thread.lineage.parentThreadId !== null ||
          thread.archivedAt !== null
        )
          continue;
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        const state = {
          active: threadRuntimeIsActive(thread.runtime),
          activeRunId: thread.runtime?.activeRunId ?? null,
          replyRunId: thread.latestRun?.runId ?? null,
          input: thread.hasPendingApprovals || thread.hasPendingUserInput,
          reply: thread.latestRun?.status === "completed" && !!thread.latestRun.assistantMessageId,
        };
        next.set(key, state);
        const now = Date.now();
        const cue = cueForTransition(
          previous.get(key),
          state,
          document.hasFocus() && key === openKey,
          !previousLive.has(thread.environmentId),
          now - lastPlayed,
        );
        if (cue && playSound(cue)) lastPlayed = now;
      }
      previous = next;
      previousLive = new Set(live);
    };
    const off = [
      appAtomRegistry.subscribe(environmentThreadShells.quietThreadShellsAtom, update),
      appAtomRegistry.subscribe(liveShellEnvironmentIdsAtom, update),
    ];
    const unlock = () => unlockSound();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    update();
    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [router]);
  return null;
}
