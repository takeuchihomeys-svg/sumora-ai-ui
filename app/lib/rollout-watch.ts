// app/lib/rollout-watch.ts — 段階で広げたスイッチの夜の見張り（悪化なら1段戻す）・判断の純関数（2026-11-03 作業員1・作業員2の設計 §5）
//
// 見る物: 見張り line_watch_turns の一致（same・same_meaning）と外れ（partial・different）。na・未判定は数えない。テスト用の会話は数えない。
//   pct:N のスイッチ … 直近7日で、そのスイッチが on の会話の組（bucket < N）と off の組の一致率を比べる（同じ週・同じ本番＝他の変化が混ざりにくい）
//   all（7日以内に all に上がった）… 上がった後の7日と、その前の7日を比べる（他の変化が混ざる＝参考の重み・線を厳しく）
//   yuma・off … 見ない（お客様に出ていない）
// 戻す線: 一致率が 5pt 以上下がり、両方の組に20番以上ある時（all の前後比べは 8pt）。戻す先は stepDown（all→pct:50→pct:10→yuma）。
//   数が足りない時は戻さず「足りない」と残す。戻した事は理由つきで rollout_overrides と知らせ（ops_anomalies の kind=rollout_down）に出す
import { stepDown, stageText, type Stage } from "./rollout";

export type GroupRate = { n: number; match: number };
export type WatchInput = { name: string; stage: Stage; on: GroupRate; off: GroupRate; mode: "pct" | "all_change" };
export type WatchDecision = { name: string; action: "down" | "keep" | "thin"; from: string; to?: string; why: string; dropPt: number | null };

export const ROLLOUT_MIN_N = 20;
export const ROLLOUT_DROP_PT = 5;
export const ROLLOUT_DROP_PT_ALL = 8;
const rate = (g: GroupRate) => (g.n ? (100 * g.match) / g.n : 0);

export function decideRollout(w: WatchInput): WatchDecision {
  const from = stageText(w.stage);
  if (w.on.n < ROLLOUT_MIN_N || w.off.n < ROLLOUT_MIN_N) return { name: w.name, action: "thin", from, why: `数が足りない（on ${w.on.n}番・off ${w.off.n}番・各 ${ROLLOUT_MIN_N} 番から）`, dropPt: null };
  const drop = Math.round((rate(w.off) - rate(w.on)) * 10) / 10;
  const line = w.mode === "all_change" ? ROLLOUT_DROP_PT_ALL : ROLLOUT_DROP_PT;
  const desc = `一致 on ${rate(w.on).toFixed(1)}%（${w.on.match}/${w.on.n}）・${w.mode === "pct" ? "off の組" : "上げる前の7日"} ${rate(w.off).toFixed(1)}%（${w.off.match}/${w.off.n}）`;
  if (drop >= line) { const to = stepDown(w.stage); return { name: w.name, action: "down", from, to: stageText(to), why: `${desc}・${drop}pt 下がった（線 ${line}pt）`, dropPt: drop }; }
  return { name: w.name, action: "keep", from, why: `${desc}・差 ${drop}pt（線 ${line}pt）`, dropPt: drop };
}

/** 見張る名前: env の <NAME>_STAGE が pct:N か all の物 */
export function watchedSwitches(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => k.endsWith("_STAGE") && /^(pct:\d+|all)$/i.test(String(env[k] ?? "").trim())).map((k) => k.slice(0, -"_STAGE".length)).sort();
}
export const isMatchVerdict = (v: string | null | undefined) => v === "same" || v === "same_meaning";
export const isJudgedVerdict = (v: string | null | undefined) => v === "same" || v === "same_meaning" || v === "partial" || v === "different";
export function rolloutWatchMode(env: Record<string, string | undefined> = process.env): "off" | "dry" | "on" { const v = String(env.ROLLOUT_WATCH ?? "").trim().toLowerCase(); return v === "on" ? "on" : v === "dry" ? "dry" : "off"; }
