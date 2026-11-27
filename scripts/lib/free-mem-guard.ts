// scripts/lib/free-mem-guard.ts — 流す前の空きメモリの関所（手元の台本の共通・LLM なし・DB なし）
// 2026-11-28 作業員L（統括役の決め）: 夜の分析で「数字を見てから流す」を3回破った（469MB・845MB・878MB で流した）＝見るだけでは止まらない。
//   流す前にこの関所を通す: 空きが min 未満なら、waitMin の間 60秒ごとに見て待ち、戻らなければ流さずに止める（例外）。
//   線: 既定 1000MB（L_MIN_FREE_MB で変える）・DB の集計だけの軽い物は 500MB を渡す（統括役 11/27 夜の決め）
import { freemem } from "node:os";

export const freeMb = (): number => Math.round(freemem() / 1048576);
export const defaultMinFreeMb = (env: Record<string, string | undefined> = process.env): number => Number(env.L_MIN_FREE_MB ?? "") || 1000;
/** 今の空きで流してよいか（純関数） */
export function freeMemVerdict(free: number, min: number): { ok: boolean; why: string } {
  return free >= min ? { ok: true, why: `空き ${free}MB（線 ${min}MB 以上）` } : { ok: false, why: `空き ${free}MB が線 ${min}MB を下回っている` };
}
/** 流す前の関所。空きが戻らなければ例外（流さない）。read は試験のために差し替えられる */
export async function requireFreeMemMb(min = defaultMinFreeMb(), o: { waitMin?: number; label?: string; read?: () => number; sleepMs?: number } = {}): Promise<number> {
  const read = o.read ?? freeMb; const deadline = Date.now() + (o.waitMin ?? 0) * 60_000; const step = o.sleepMs ?? 60_000;
  for (;;) {
    const free = read(); const v = freeMemVerdict(free, min);
    if (v.ok) return free;
    if (Date.now() >= deadline) throw new Error(`[空きメモリの関所${o.label ? `・${o.label}` : ""}] ${v.why}＝流さない`);
    console.log(`[空きメモリの関所${o.label ? `・${o.label}` : ""}] ${v.why}・待つ`);
    await new Promise((r) => setTimeout(r, step));
  }
}
