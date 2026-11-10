// scripts/lib/exam-near-hook.ts — 試験の係（exam-conductor）の前段で「鍵が要る読み」の頼み（db-snapshot/<日>/pending）を解く
//
// 2026-11-10 作業員8（統括役の頼み・作業員4 の提案）: 頼みは夜に手で exam-near-resolve を回すまで残り、同じ日に固定した次の試験は
//   控えが無いまま（近い番が空のまま）流れていた。係が ①試験の依頼が終わって新しい頼みができた直後 ②試験の依頼を流す前 に解く。
//   鍵のある env のパスは exam-queue/config.json の nearResolveEnv か EXAM_NEAR_RESOLVE_ENV（無ければ解かずに1回だけ知らせる・今まで通り）。
//   EXAM_NEAR_RESOLVE_HOOK=off で止める。LLM は呼ばない（DB を読むだけ・頼み1つにつき1回）
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 日ごとの頼みの数（pending の .json） */
export function pendingCounts(snapshotRoot: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!existsSync(snapshotRoot)) return out;
  for (const d of readdirSync(snapshotRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const p = join(snapshotRoot, d, "pending");
    if (!existsSync(p)) continue;
    const n = readdirSync(p).filter((f) => f.endsWith(".json")).length;
    if (n) out[d] = n;
  }
  return out;
}

/** 試験の依頼か（型の確かめ・読むだけの cmd は頼みを作らないので解かない） */
export function isExamJob(j: { runner?: string; readOnly?: boolean }): boolean {
  return j.runner !== "tsc" && j.runner !== "tsc-remote" && !(j.runner === "cmd" && j.readOnly);
}

export type NearHookDecision = { run: false; why: string } | { run: true; envPath: string; days: string[]; total: number };
/** 解くか（純）。stage: before＝依頼を流す前・after＝依頼が終わった後 */
export function decideNearResolve(i: {
  job: { runner?: string; readOnly?: boolean };
  counts: Record<string, number>;
  configEnv?: string | null;
  env?: Record<string, string | undefined>;
  envExists: (p: string) => boolean;
}): NearHookDecision {
  const env = i.env ?? {};
  if ((env.EXAM_NEAR_RESOLVE_HOOK ?? "").trim().toLowerCase() === "off") return { run: false, why: "switch_off" };
  if (!isExamJob(i.job)) return { run: false, why: "not_exam" };
  const days = Object.keys(i.counts).filter((d) => i.counts[d] > 0).sort();
  if (!days.length) return { run: false, why: "no_pending" };
  const envPath = (i.configEnv ?? "").trim() || (env.EXAM_NEAR_RESOLVE_ENV ?? "").trim();
  if (!envPath) return { run: false, why: "no_env" };
  if (!i.envExists(envPath)) return { run: false, why: "env_missing" };
  return { run: true, envPath, days, total: days.reduce((a, d) => a + i.counts[d], 0) };
}
