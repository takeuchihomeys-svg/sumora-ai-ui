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

/**
 * 漏れの番人（強化の一覧 D3・2026-11-10 作業員8）: 近い番の読み（match_conductor_focus／turns）の答えに、
 *   距離 0.01 未満（＝元の番そのもの）か、元の番（頼みの p_before）より後の時刻の番が1本でもあれば漏れ（11/10 の 8c1b057c の前は q371 で 0.001・30本以上）。
 *   exam-near-resolve が控えを書く前に見て、漏れなら控えを書かずに <置き場>/leak-stop.json を置く＝係は試験の依頼を止めて知らせる
 */
export const LEAK_DISTANCE = 0.01;
export function nearLeak(name: string, reqBody: string, rows: ReadonlyArray<Record<string, unknown>>): { leak: boolean; close: number; after: number } {
  if (name !== "match_conductor_focus" && name !== "match_conductor_turns") return { leak: false, close: 0, after: 0 };
  let before = NaN;
  try { const b = JSON.parse(reqBody) as Record<string, unknown>; before = Date.parse(String(b.p_before ?? "")); } catch { /* 頼みの中身が読めない時は時刻を見ない */ }
  let close = 0, after = 0;
  for (const r of rows) {
    const d = typeof r.distance === "number" ? r.distance : Number(r.distance);
    if (Number.isFinite(d) && d < LEAK_DISTANCE) close++;
    const t = Date.parse(String(r.turn_at ?? ""));
    if (Number.isFinite(before) && Number.isFinite(t) && t > before) after++;
  }
  return { leak: close + after > 0, close, after };
}
export const LEAK_STOP_FILE = "leak-stop.json";

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

/**
 * 解いてはいけない近い番の頼みか（純・2026-11-10 作業員8）: match_conductor_focus／turns で、答えの番を外していない頼み。
 *   ① 印（ls: 1）があれば解く（この版以降の exam-frozen-input が元の番が分かった時だけ付ける）
 *   ② 印が無い時は中身で見る: p_exclude_conv が無い・テスト用の会話（YUMA・YUMA2〜）＝8c1b057c より古い作業ツリーの頼み（11/09 k-a9e10def は tc-narrow〔origin/main より23個古い〕が 19:44 JST に作った・p_exclude_conv＝YUMA2・p_before＝本当の今）
 */
export function isUnsafeNearRequest(req: { name?: string; body?: string; ls?: number | null }, testConvIds: readonly string[]): boolean {
  if (req.name !== "match_conductor_focus" && req.name !== "match_conductor_turns") return false;
  if (req.ls === 1) return false;
  let ex: unknown = null;
  try { ex = (JSON.parse(String(req.body ?? "")) as Record<string, unknown>).p_exclude_conv ?? null; } catch { return true; }
  return typeof ex !== "string" || !ex || testConvIds.includes(ex);
}
