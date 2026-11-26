// scripts/lib/exam-night-smoke.ts — 台帳 #799 ①: 晩の最初の煙の1問（純関数・LLM なし・DB なし）
// 2026-11-26 作業員L（統括役の頼み・試験の質 p0）: 11/25 の晩は、静的な文の「出所」で場面の網がブレインの呼び出し（brain_full）を全部止めたまま、
//   晩の組が全部流れて費用だけ使い、外れは「ブレインの答えなし」になった。係は晩の最初の試験の依頼を流す前に、その依頼の1問だけを1回（判定なし・前と比べない）流し、
//   ブレインの呼び出しが1回も届かない（試験の道具の集計は出たのに brain* が0回）なら、その晩の試験を止めて印を置く（毎朝の1枚に ⚠）。
//   集計の行が出ない（始まる前に落ちた）は分からない＝止めない（印に ⚠ だけ・始まりの落ちは handleStartCrash が見る）。
//   晩の鍵は exam-night-jobs.nightKeyOf（JST の日付を12時で切った日）。止める: EXAM_NIGHT_SMOKE=off
import { nightKeyOf } from "./exam-night-jobs";

export const SMOKE_MARK_FILE = "night-smoke-last.json";
export type SmokeMark = { key: string; at: string; ok: boolean | null; why: string; brainCalls: number; blocked: number; label: string; job: string; problem: string };
export type SmokeVerdict = { ok: boolean | null; brainCalls: number; blocked: number; why: string };

export function smokeOn(env: Record<string, string | undefined> = {}): boolean { return (env.EXAM_NIGHT_SMOKE ?? "").trim().toLowerCase() !== "off"; }

/** この晩に煙の1問を流すか（純関数）: 試験の依頼で、この晩の印がまだ無い時だけ */
export function smokeDue(job: { runner?: string; dig?: boolean; only?: string } | null | undefined, mark: Pick<SmokeMark, "key"> | null | undefined, nowMs: number, env: Record<string, string | undefined> = {}): { due: boolean; key: string } {
  const key = nightKeyOf(nowMs);
  if (!smokeOn(env) || !job || job.runner !== "brain-exam" || !String(job.only ?? "").split(",").some(Boolean)) return { due: false, key };
  const h = new Date(nowMs + 9 * 3_600_000).getUTCHours();
  if (!(h >= 22 || h < 8)) return { due: false, key }; // 晩（JST 22〜翌8時）だけ。昼の --day-ok の依頼でその晩の印を使わない
  return { due: mark?.key !== key, key };
}

/** 煙の1問に使う問題（守りでない最初の問題・無ければ最初の問題） */
export function smokeProblemOf(ids: readonly string[], guards: readonly string[] = []): string | null {
  const g = new Set(guards);
  return ids.find((x) => !g.has(x)) ?? ids[0] ?? null;
}

/**
 * 煙の1問の出力（brain-exam の試験の道具の集計）を読む（純関数）。
 *   届いた数＝試験の道具の数え（名札ごと 呼んだ/再生）の brain* の和。無ければ llm_usage_logs の行（status の付かない brain*）の和。
 *   止めた数＝「止めた N回」と「⛔ テストの歯止めで止めた呼び出し N回」の大きい方。
 */
export function smokeVerdictOf(out: string): SmokeVerdict {
  const text = String(out ?? "");
  const hasSummary = /=== llm_usage_logs（/.test(text) || /=== この回の API（/.test(text);
  let brainCalls = 0;
  let fromCassette = false;
  for (const m of text.matchAll(/名札ごと（呼んだ\/再生\/止めた）: ([^\n]+)/g)) {
    fromCassette = true;
    for (const part of m[1].split("・")) { const x = /^(brain\S*) (\d+)\/(\d+)/.exec(part.trim()); if (x) brainCalls += Number(x[2]) + Number(x[3]); }
  }
  if (!fromCassette) for (const m of text.matchAll(/^\s*(\d+)回 \$[\d.]+\s+(brain\S*) (\S+)\s*$/gm)) brainCalls += Number(m[1]);
  const blocked = Math.max(0, ...[...text.matchAll(/止めた (\d+)回/g)].map((m) => Number(m[1])), ...[...text.matchAll(/止めた呼び出し (\d+)回/g)].map((m) => Number(m[1])));
  const firstBlock = /⛔ テストの歯止めで止めた呼び出し \d+回[^\n]*\n\s*([^\n]+)/.exec(text)?.[1]?.trim() ?? "";
  if (!hasSummary) return { ok: null, brainCalls, blocked, why: "試験の道具の集計が出ない（始まる前に落ちた？）＝分からないので止めない" };
  if (brainCalls === 0) return { ok: false, brainCalls, blocked, why: `ブレインの呼び出しが1回も届かない（止めた ${blocked}回${firstBlock ? `・${firstBlock.slice(0, 120)}` : ""}）` };
  return { ok: true, brainCalls, blocked, why: `ブレイン ${brainCalls}回届いた${blocked ? `（止めた ${blocked}回）` : ""}` };
}

/** 係の関所: この晩の煙の1問で止めた印があれば、試験の依頼（tsc・読むだけ以外）を止める理由（純関数・無ければ null） */
export function smokeHoldWhy(job: { runner?: string; readOnly?: boolean } | null | undefined, mark: SmokeMark | null | undefined, nowMs: number, env: Record<string, string | undefined> = {}): string | null {
  if (!smokeOn(env) || !job || !mark || mark.ok !== false) return null;
  if (job.runner === "tsc" || job.runner === "tsc-remote" || (job.runner === "cmd" && job.readOnly)) return null;
  if (mark.key !== nightKeyOf(nowMs)) return null;
  return `晩の煙の1問で止めた（${mark.problem}・${mark.why}）＝この晩の試験は流さない。直して conductor-marks/${SMOKE_MARK_FILE} を消すと流れる`;
}

/** 毎朝の1枚の1行（この晩の印が無ければ「流れていない」・純関数） */
export function smokeMorningLine(mark: SmokeMark | null | undefined, nowMs: number): string {
  const key = nightKeyOf(nowMs);
  if (!mark || mark.key !== key) return `- 晩の煙の1問（${key} の晩）: 流れていない（試験の依頼が無かった・EXAM_NIGHT_SMOKE=off）`;
  if (mark.ok === false) return `- 晩の煙の1問（${key} の晩）: ⚠ 止めた＝晩の試験を流していない（${mark.problem}・${mark.why}）`;
  if (mark.ok == null) return `- 晩の煙の1問（${key} の晩）: ⚠ 分からない（${mark.why}）`;
  return `- 晩の煙の1問（${key} の晩）: 通った（${mark.problem}・${mark.why}）`;
}
