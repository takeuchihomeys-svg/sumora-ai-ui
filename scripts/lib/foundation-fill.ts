// scripts/lib/foundation-fill.ts — 土台の埋まりの表（純関数・作業員N・2026-11-21・台帳の priority 0「土台の統括」）
//
// 竹内さん 11/21「土台足りていない部分あればちゃんといれていき、細部までもととのえていくようにする」「そこもちゃんと細かくととのえていくようにする」。
//   check-foundation の土台の帳面（決まり・物差し・本番の数字・担当の部品の4列）と、foundation-scene-grid の土台×場面の表（場面の決まり・物差しが場面で分かれるか）を1つの表にする。
//   欄ごとに ①埋まっているか ②中身が正しいか ③持ち主 ④次の一手 を持つ。土台ごとに「細かさの段」と「正しさの割合」を出す。
//   正しさ（推測で埋めない・測れない物は null＝未測定）:
//     決まり … 竹内さんの実送信の何%が守っているか（守り率の台本がまだ無い＝未測定）
//     物差し … 本番の数が7日に出ているか（quality_daily）
//     本番の数字 … 7日に入っているか（埋まり＝正しさ）
//     部品 … コードの既定が on か（LINKAGE_SWITCH_DEFAULTS・地図に無いスイッチは未測定）
//   細かさの段: 無い → 一部の場面 → 場面まで → 状況まで（状況で分ける所は竹内さんの実送信で形が割れると確かめた所だけ・SITUATION_CANDIDATES は未確認の候補）
// テスト: scripts/lib/__tests__/foundation-fill.test.ts
import type { FoundationRow, FoundationGap } from "./foundation-table";

export type FillCol = "rules" | "measures" | "metric" | "parts" | "scene_rules" | "scene_measure";
export const FILL_COL_JA: Record<FillCol, string> = { rules: "決まり", measures: "物差し", metric: "本番の数字", parts: "担当の部品", scene_rules: "場面の決まり", scene_measure: "物差しが場面で分かれる" };
export type FillCell = { col: FillCol; filled: boolean; correct: boolean | null; owner: string; next: string | null; detail: string };
export type FillRow = { id: string; name: string; owner: string; cells: FillCell[]; depth: "無い" | "一部の場面" | "場面まで" | "状況まで" | "—"; correctOk: number; correctMeasured: number; emptyScenes: string[] };
export type SceneGridLike = { scenes: string[]; grid: Array<{ id: string; measure: "場面ごと" | "全体だけ" | "無い"; cells: Record<string, number>; all: number }> };

/** 状況で分ける候補（統括役 11/21 の例）。竹内さんの実送信で形が割れると確かめるまでは段に数えない */
export const SITUATION_CANDIDATES: Record<string, string[]> = {
  conditions: ["初回", "言い直し", "広げる"],
  property_share: ["1件", "複数", "URLだけ"],
};
/** 実送信で形が割れると確かめた場面→状況（確かめた物だけ足す・今は無い） */
export const SITUATION_CONFIRMED: Record<string, Record<string, string[]>> = {};

const first = (owner: string) => owner.split("・")[0] || "統括役";

export function foundationFillOf(
  rows: ReadonlyArray<FoundationRow>,
  gaps: ReadonlyArray<FoundationGap>,
  grid: SceneGridLike | null,
  o: { metricSeen: (m: string) => boolean; switchDefault: (s: string) => string | null },
): FillRow[] {
  const gapOf = new Map(gaps.map((g) => [g.id, g]));
  return rows.map((r) => {
    const g = gapOf.get(r.id);
    const miss = new Set(g?.missing ?? []);
    const own = first(r.owner);
    const cells: FillCell[] = [];
    cells.push({ col: "rules", filled: !miss.has("rules"), correct: null, owner: own,
      next: miss.has("rules") ? "竹内さんの実送信で過半数の形を数える → KB 案（P2）／割れたら推奨つきの確認案" : "守り率（竹内さんの実送信の何%が守っているか）を数える台本を作る",
      detail: r.rules.length ? `KB ${r.rules.join(",")}` : "決まり（KB）が無い" });
    cells.push({ col: "measures", filled: !miss.has("measures"), correct: miss.has("measures") ? false : (r.metric ? o.metricSeen(r.metric) : false), owner: own,
      next: miss.has("measures") ? "物差しの台本を作る（読むだけ・費用0）" : (r.metric && o.metricSeen(r.metric) ? null : "台本の数を本番で毎日出す"),
      detail: r.measures.join("・") || "台本が無い" });
    cells.push({ col: "metric", filled: !miss.has("metric"), correct: !miss.has("metric"), owner: own,
      next: miss.has("metric") ? (miss.has("measures") ? "物差しの後に quality_daily へ" : "台本の数を quality_daily に毎日書く（毎朝の1枚から呼ぶ）") : null,
      detail: r.metric ?? "毎日の数が無い" });
    const sw = r.parts.map((p) => ({ p, d: o.switchDefault(p) }));
    const known = sw.filter((x) => x.d !== null);
    const partsCorrect = miss.has("parts") ? false : known.length ? known.some((x) => x.d === "on") : null;
    cells.push({ col: "parts", filled: !miss.has("parts"), correct: partsCorrect, owner: own,
      next: miss.has("parts") ? "担当の部品（スイッチ）を決めて既定 off で作る" : partsCorrect === false ? "既定 on の部品が無い＝試験で悪化0を確かめて on" : partsCorrect === null ? "スイッチを連携の地図に載せて既定を読めるようにする" : null,
      detail: sw.map((x) => `${x.p}=${x.d ?? "?"}`).join("・") || "部品が無い" });
    const gr = grid?.grid.find((x) => x.id === r.id);
    let emptyScenes: string[] = [];
    let depth: FillRow["depth"] = "—";
    if (gr && grid) {
      emptyScenes = grid.scenes.filter((s) => !gr.cells[s]);
      // 全場面（P0/P1）の決まりがあっても、場面ごとの決まりが無い場面は空き（統括役 11/21: 場面の決まりの空き 22 を埋める）
      cells.push({ col: "scene_rules", filled: emptyScenes.length === 0, correct: null, owner: own,
        next: emptyScenes.length ? `場面ごとに竹内さんの実送信の過半数→KB 案（P2）／割れたら確認案（${emptyScenes.join("・")}）` : "状況で分けるかを実送信で確かめる",
        detail: `場面の決まりの無い場面 ${emptyScenes.length}/${grid.scenes.length}${gr.all ? `・全場面の決まり ${gr.all}` : ""}` });
      cells.push({ col: "scene_measure", filled: gr.measure === "場面ごと", correct: null, owner: own,
        next: gr.measure === "場面ごと" ? null : gr.measure === "無い" ? "物差しの台本を作る（場面で分けて数える）" : "台本を場面で分けて数える",
        detail: gr.measure });
      const confirmed = Object.keys(SITUATION_CONFIRMED[r.id] ?? {}).length;
      depth = emptyScenes.length === grid.scenes.length && !gr.all ? "無い" : emptyScenes.length ? "一部の場面" : confirmed ? "状況まで" : "場面まで";
    }
    const measured = cells.filter((c) => c.correct !== null);
    return { id: r.id, name: r.name, owner: r.owner, cells, depth, correctOk: measured.filter((c) => c.correct).length, correctMeasured: measured.length, emptyScenes };
  });
}

/** 毎朝の数（quality_daily）: 欄が全部そろった土台・場面の決まりの空き（全場面の決まりも無い欄）・物差しの無い土台 */
export function fillTotalsOf(fill: ReadonlyArray<FillRow>, grid: SceneGridLike | null) {
  const full = fill.filter((r) => r.cells.every((c) => c.filled)).length;
  let sceneStrict = 0, sceneCells = 0;
  for (const g of grid?.grid ?? []) for (const s of grid!.scenes) { sceneCells++; if (!g.cells[s] && !g.all) sceneStrict++; }
  // 場面の決まりの空き＝場面ごとの決まりの無い欄（全場面の決まりがあっても数える）。sceneStrict は全場面の決まりも無い欄
  const sceneGap = (grid?.grid ?? []).reduce((a, g) => a + grid!.scenes.filter((s) => !g.cells[s]).length, 0);
  const noMeasure = fill.filter((r) => r.cells.some((c) => c.col === "measures" && !c.filled));
  const ok = fill.reduce((a, r) => a + r.correctOk, 0), meas = fill.reduce((a, r) => a + r.correctMeasured, 0);
  return { n: fill.length, full, sceneGap, sceneStrict, sceneCells, noMeasure: noMeasure.length, noMeasureNames: noMeasure.map((r) => r.name), correctRate: meas ? Math.round((ok / meas) * 1000) / 10 : null, correctMeasured: meas };
}

/** 前の日から減らない所を持ち主つきで（純関数）。数が0なら出さない */
export function fillNotShrinking(now: { full: number; n: number; sceneGap: number; noMeasure: number }, prev: { full: number | null; sceneGap: number | null; noMeasure: number | null }, owners: { sceneGap: string[]; noMeasure: string[]; notFull: string[] }): string[] {
  const out: string[] = [];
  if (now.sceneGap > 0 && prev.sceneGap != null && now.sceneGap >= prev.sceneGap) out.push(`場面の決まりの空き ${now.sceneGap}（前の日 ${prev.sceneGap}）が減っていない → ${[...new Set(owners.sceneGap)].join("・")}`);
  if (now.noMeasure > 0 && prev.noMeasure != null && now.noMeasure >= prev.noMeasure) out.push(`物差しの無い土台 ${now.noMeasure}（前の日 ${prev.noMeasure}）が減っていない → ${[...new Set(owners.noMeasure)].join("・")}`);
  if (now.full < now.n && prev.full != null && now.full <= prev.full) out.push(`欄が全部そろった土台 ${now.full}/${now.n}（前の日 ${prev.full}）が増えていない → ${[...new Set(owners.notFull)].slice(0, 6).join("・")}`);
  return out;
}
