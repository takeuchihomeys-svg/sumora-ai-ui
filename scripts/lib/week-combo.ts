// scripts/lib/week-combo.ts — 台帳 #799 ⑤: その週に on にした直しを全部 on にした組を週1回（純関数・LLM なし）
// 2026-11-26 作業員L（統括役の頼み）: 直しは1本ずつ試験で悪化0を確かめて on にしているが、同じ週に on にした物どうしが重なった時の悪化は誰も見ていない。
//   週に1回、その週に on にした直しのスイッチを全部 on にした組を、週の最初の on より前の main（--baseline=main@<ref>）と比べる。
//   効く問題＝各直しの効く問題（係の候補の「効く」と係の結果の問題）の和。多い時は直しごとに順に1問ずつ取って 12問まで（どの直しも落とさない）。守りは各直しの守りから足りるだけ。
//   費用は晩の上限（$10）の内に収まる見込みだけを候補に並べる（積むのは係の候補に並べるまで・流す晩は案＝日曜の晩）。
import { BRAIN_USD_PER_REP } from "./exam-plan";

export type WeekFix = { switchName: string; itemId: number; onAt: string; eff: string[]; guards: string[] };
export type WeekCombo = { name: string; night: string; switches: string[]; items: number[]; eff: string[]; guards: string[]; baseRef: string | null; usd: number; fits: boolean; dropped: string[]; block: string };

/** 次の日曜（from の日を含む・JST の日付・from 以降で一番早い日曜。notBefore より前なら notBefore 以降の日曜） */
export function nextSunday(from: string, notBefore = ""): string {
  let d = from < notBefore ? notBefore : from;
  for (let i = 0; i < 7; i++) { if (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) return d; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10); }
  return d;
}
/** 直しごとに順に1問ずつ取る（どの直しの効く問題も入る・重なりは1つ・純関数） */
export function roundRobin(lists: ReadonlyArray<readonly string[]>, max: number): string[] {
  const out: string[] = []; const seen = new Set<string>();
  for (let k = 0; out.length < max; k++) {
    let any = false;
    for (const xs of lists) { if (k >= xs.length) continue; any = true; const id = xs[k]; if (!seen.has(id)) { seen.add(id); out.push(id); if (out.length >= max) break; } }
    if (!any) break;
  }
  return out;
}
export function weekComboOf(fixes: readonly WeekFix[], o: { day: string; baseRef: string | null; notBefore?: string; night?: string; maxEff?: number; maxGuards?: number; repeat?: number; capUsd?: number; spentUsd?: number }): WeekCombo | null {
  const withSw = fixes.filter((f) => f.switchName);
  if (withSw.length < 2) return null; // 1本だけの週は重なりが無い
  const maxEff = o.maxEff ?? 10, maxGuards = o.maxGuards ?? 2, repeat = o.repeat ?? 2, cap = o.capUsd ?? 10;
  const switches = [...new Set(withSw.map((f) => f.switchName))].sort();
  const eff = roundRobin(withSw.map((f) => f.eff), maxEff);
  const guards = roundRobin(withSw.map((f) => f.guards.filter((g) => !eff.includes(g))), maxGuards);
  const dropped = withSw.filter((f) => f.eff.length && !f.eff.some((x) => eff.includes(x))).map((f) => f.switchName);
  // 見込み: 今の回（効く×回・守り×1）＋前の回（main@ref の答えが無い前提で同じ数）
  const usd = Math.round((eff.length * repeat + guards.length) * 2 * BRAIN_USD_PER_REP * 1000) / 1000;
  const fits = (o.spentUsd ?? 0) + usd <= cap;
  const night = o.night || nextSunday(o.day, o.notBefore ?? ""); // --night で晩を手で決める（統括役の決め・最初の週は 11/30 の晩）
  const name = `week-combo-${night}`;
  const block = [
    `## ${o.day} 作業員L: 週の全部 on の組（台帳 #799 ⑤・その週に on にした ${switches.length}本・流す晩の案 ${night}${new Date(`${night}T00:00:00Z`).getUTCDay() === 0 ? "（日曜）" : ""}・見込み $${usd.toFixed(2)}${fits ? "" : "・⚠ 晩の上限を超える＝問題を減らす"}）`,
    `- 組: ${name} ${switches.join(" ")} stage=brain`,
    `- 効く: ${eff.join(",") || "（無し＝各直しの効く問題が分からない）"}`,
    `- 守り: ${guards.join(",") || "なし"}`,
    `- 比べる前: ${o.baseRef ? `--baseline=main@${o.baseRef}（週の最初の on より前の main）` : "（週の最初の on より前の commit が分からない＝ main）"}・env は ${switches.map((s) => `${s}=on`).join(" ")}`,
    `- 台帳: ${[...new Set(withSw.map((f) => `#${f.itemId}`))].join("・")}${dropped.length ? `・効く問題が入らなかった直し: ${dropped.join(",")}` : ""}`,
  ].join("\n");
  return { name, night, switches, items: [...new Set(withSw.map((f) => f.itemId))], eff, guards, baseRef: o.baseRef, usd, fits, dropped, block };
}
