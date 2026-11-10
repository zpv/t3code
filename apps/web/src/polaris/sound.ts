import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "~/lib/storage";

export type Cue = "completion" | "input";
export interface SoundState {
  active: boolean;
  input: boolean;
  reply: boolean;
  activeRunId?: string | null;
  replyRunId?: string | null;
}
export function cueForTransition(
  previous: SoundState | undefined,
  next: SoundState,
  focused: boolean,
  initial: boolean,
  sinceLast: number,
): Cue | null {
  if (initial || !previous?.active || focused || sinceLast < 2000) return null;
  if (next.input && !previous.input) return "input";
  if (!next.active && next.reply && previous.activeRunId != null && previous.activeRunId === next.replyRunId) return "completion";
  return null;
}
export function noteSchedule(cue: Cue) {
  return (cue === "completion" ? [659.255, 783.991, 1046.502] : [783.991, 659.255]).map(
    (frequency, index) => ({
      frequency,
      start: index * 0.09,
      duration: 0.09,
      attack: 0.006,
      release: 0.06,
    }),
  );
}
export const useSoundSettings = create<{
  enabled: boolean;
  volume: number;
  setEnabled: (value: boolean) => void;
  setVolume: (value: number) => void;
}>()(
  persist(
    (set) => ({
      enabled: true,
      volume: 2,
      setEnabled: (enabled) => set({ enabled }),
      setVolume: (volume) => set({ volume }),
    }),
    {
      name: "polaris-sound",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ enabled, volume }) => ({ enabled, volume }),
    },
  ),
);
let context: AudioContext | null = null;
let unlocked = false;
export function unlockSound() {
  unlocked = true;
  context ??= new AudioContext();
  void context.resume();
}
export function playSound(cue: Cue, test = false) {
  const { enabled, volume } = useSoundSettings.getState();
  if (!unlocked || (!enabled && !test) || !context || context.state !== "running") return false;
  const master = context.createGain();
  master.gain.value = [0, 0.06, 0.12, 0.2][volume] ?? 0.12;
  master.connect(context.destination);
  const delay = context.createDelay();
  delay.delayTime.value = 0.08;
  const echo = context.createGain();
  echo.gain.value = 0.3;
  delay.connect(echo).connect(master);
  const now = context.currentTime;
  for (const note of noteSchedule(cue))
    for (const [type, frequency, gain] of [
      ["square", note.frequency, 0.7],
      ["triangle", note.frequency / 2, 0.3],
    ] as const) {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      const start = now + note.start;
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(gain, start + note.attack);
      envelope.gain.setValueAtTime(gain, start + note.duration - note.release);
      envelope.gain.linearRampToValueAtTime(0, start + note.duration);
      oscillator.connect(envelope);
      envelope.connect(master);
      envelope.connect(delay);
      oscillator.start(start);
      oscillator.stop(start + note.duration);
    }
  return true;
}
