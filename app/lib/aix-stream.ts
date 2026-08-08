import { AsyncLocalStorage } from "node:async_hooks";

export type AixEvent =
  | { t: "phase"; phase: "prepare" | "vision" | "generating" | "adapt"; label: string }
  | { t: "reset"; seq: number }
  | { t: "delta"; seq: number; text: string }
  | { t: "done"; payload: unknown }
  | { t: "error"; error: string };

export type AixStreamCtx = {
  emit: (ev: AixEvent) => void;
  deadline: number;
  signal: AbortSignal;
  seq: number;
  busy: boolean;
};

export const aixStream = new AsyncLocalStorage<AixStreamCtx>();

export function emitPhase(phase: "prepare" | "vision" | "generating" | "adapt", label: string) {
  aixStream.getStore()?.emit({ t: "phase", phase, label });
}

export function remainingMs(fallback: number): number {
  const s = aixStream.getStore();
  return s ? Math.max(0, s.deadline - Date.now()) : fallback;
}

export function budgetSignal(maxMs: number): AbortSignal {
  const s = aixStream.getStore();
  if (!s) return AbortSignal.timeout(maxMs);
  const budget = Math.max(1_000, Math.min(maxMs, s.deadline - Date.now()));
  return AbortSignal.any([AbortSignal.timeout(budget), s.signal]);
}
