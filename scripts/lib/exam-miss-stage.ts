import { ownersOfMarker } from "../../app/lib/conductor-linkage";
// scripts/lib/exam-miss-stage.ts — 試験の外れ・悪化の問題で「どの段で道が変わったか」を答案の記録だけで出す（純関数・LLM なし）
//
// 2026-11-06 作業員8（竹内さんの決定 KB P1「試験から改善の仕方も強化・統括同士連携」・統括役の頼み「外れの自動の切り分け」）:
//   11/05〜06 の外れの原因の多くは、ブレインの後の決まった計算の書き換え（two-stage の check_question・guard・場面の網と信号・最終チェックの消し）で、
//   作業員が記録を手で読んで見つけていた。段の順に、答案の行の印を見て最初に道が変わった段を出す:
//     ブレインの生の答え（essence＝LLM が最初に出した道）→ 2段（trace.two_stage）→ 場面の網と信号（trace.scene_evidence）
//     → 決まった書き換え（trace.decision_source_no_aix / decision_source の rule:・guard:）→ 書き手（draft.code）→ 最終チェック
//   原因の3つ（材料が届いていない／場面・決まりの読み違い／AIX の番を返信にした）への振り分けは下書き（人が確かめる）。
//   持ち主の統括は、連携の表（作業員5・writes の印の名前・前方一致）で引く。表が来るまでは下の仮の表。

export type MissRowLite = {
  id: string;
  essence?: { code?: string | null; ok?: boolean | null } | null;
  path?: { code?: string | null; ok?: boolean | null } | null;
  draft?: { code?: string | null; ok?: boolean | null; pass?: boolean | null } | null;
  trace?: Record<string, unknown> | null;
  brain?: { demoted_overrides?: unknown } | null;
  asks?: Array<{ covered?: boolean; route?: boolean }> | null;
  score?: { pass?: boolean; path?: boolean } | null;
};
export type MissStage = "brain" | "two_stage" | "scene_net" | "rewrite" | "writer" | "final_check" | "asks" | "none";
export type MissCause = "材料が届いていない" | "場面・決まりの読み違い" | "AIX の番を返信にした" | "要確認";
export type MissVerdict = { id: string; stage: MissStage; markers: string[]; from: string | null; to: string | null; cause: MissCause; line: string };

const isReplyLike = (c: string | null | undefined) => !!c && (c === "返信" || c.startsWith("2段") || c.startsWith("2択"));
const isAix = (c: string | null | undefined) => !!c && c.startsWith("AIX:");

/** 答案の行の印（連携の表の writes と同じ名前・前方一致で引く） */
export function markersOf(r: MissRowLite): string[] {
  const t = (r.trace ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["decision_source_no_aix", "decision_source"]) {
    const v = typeof t[k] === "string" ? String(t[k]) : "";
    if (v) out.push(`decision:${v.replace(/^rule:/, "")}`);
  }
  if (typeof t.two_stage === "string" && t.two_stage) out.push(`two_stage:${t.two_stage}`);
  const se = t.scene_evidence as { scene?: string } | null | undefined;
  if (se && se.scene) out.push(`scene_net:${se.scene}`);
  const dem = (r.brain?.demoted_overrides ?? []) as unknown;
  if (Array.isArray(dem)) for (const d of dem) { const n = typeof d === "string" ? d : (d as { kind?: string; name?: string })?.kind ?? (d as { name?: string })?.name; if (n) out.push(`demoted:${n}`); }
  return out;
}

/** 1つの外れの行の切り分け */
export function classifyMiss(r: MissRowLite): MissVerdict {
  const ess = r.essence?.code ?? null, fin = r.path?.code ?? null, dr = r.draft?.code ?? null;
  const m = markersOf(r);
  const mk = (stage: MissStage, from: string | null, to: string | null, cause: MissCause, why: string): MissVerdict =>
    ({ id: r.id, stage, markers: stage === "writer" || stage === "final_check" ? [stage, ...m] : m, from, to, cause, line: `${r.id}: ${STAGE_JA[stage]}で ${from ?? "?"} → ${to ?? "?"}（${why}・原因の下書き: ${cause}）` });
  // ① ブレインの生の答え（essence）と最終の道が違う＝後の段が道を変えた（生の答えが正解でも外れでも、変えた段を出す＝手で見つけた段と同じ所を指す）
  if (ess && fin && ess !== fin) {
    const rw = m.filter((x) => x !== "decision:llm");
    const ts = rw.find((x) => x.startsWith("two_stage:")), dec = rw.find((x) => x.startsWith("decision:")), sc = rw.find((x) => x.startsWith("scene_net:"));
    const after = r.essence?.ok ? "（生の答えは正解）" : "（生の答えも正解ではない）";
    const cause: MissCause = r.essence?.ok ? (isAix(ess) && isReplyLike(fin) ? "AIX の番を返信にした" : "場面・決まりの読み違い") : "要確認";
    if ((dec && /two_stage|check_question/.test(dec)) || ts) return mk("two_stage", ess, fin, cause, `2段の決まった書き換え ${dec ?? ts}${after}`);
    if (dec && /guard|answerable|direct/.test(dec)) return mk("rewrite", ess, fin, cause, `決まった書き換え ${dec}${after}`);
    if (dec) return mk("rewrite", ess, fin, cause, `決まった書き換え ${dec}${after}`);
    if (m.includes("decision:llm")) return mk("brain", ess, fin, r.essence?.ok ? "場面・決まりの読み違い" : "要確認", `2層目（今回の発言）のブレインが変えた${sc ? `・場面 ${sc}` : ""}${after}`);
    if (sc) return mk("scene_net", ess, fin, cause, `場面の網と信号 ${sc}${after}`);
    return mk("rewrite", ess, fin, cause, `印が無い書き換え（記録を足す所）${after}`);
  }
  // ② 最終の道は正解・下書きで道が変わった＝書き手
  if (r.path?.ok && dr && fin && dr !== fin && r.draft?.ok === false) return mk("writer", fin, dr, "場面・決まりの読み違い", "下書きの道が最終の道と違う");
  // ③ 道は正解・下書きの道も同じ・要点が抜けた＝最終チェックの消しか書き手（下書きの合否で分ける）
  if (r.path?.ok && r.draft && r.draft.ok !== false && r.draft.pass === false) return mk("final_check", fin, dr, "要確認", "道は同じで下書きの要点が抜けた（最終チェックの消しか書き手）");
  // ④ 道は正解・依頼の答え方で外れ
  if (r.path?.ok && (r.asks ?? []).some((a) => a.covered === false)) return mk("asks", fin, fin, "要確認", "道は正解で依頼の答え方が抜けた");
  // ⑤ ブレインの生の答えから外れ
  if (r.essence && r.essence.ok === false) {
    const cause: MissCause = isReplyLike(ess) && !isReplyLike(fin) ? "要確認" : isReplyLike(ess) ? "AIX の番を返信にした" : "要確認";
    return mk("brain", ess, fin, cause, `ブレインの生の答えから外れ${m.length ? `（後の印 ${m.slice(0, 2).join("・")}）` : ""}`);
  }
  return mk("none", ess, fin, "要確認", "段が決められない");
}

export const STAGE_JA: Record<MissStage, string> = { brain: "ブレインの生の答え", two_stage: "2段", scene_net: "場面の網と信号", rewrite: "決まった書き換え", writer: "書き手", final_check: "最終チェック", asks: "依頼の答え方", none: "（不明）" };

/** 同じ問題の外れの回をまとめる（一番多い段・印） */
export function summarizeMisses(rows: MissRowLite[]): { id: string; n: number; stage: MissStage; markers: string[]; line: string } | null {
  const bad = rows.filter((r) => r.score && r.score.pass === false);
  if (!bad.length) return null;
  const vs = bad.map(classifyMiss);
  const cnt = new Map<MissStage, number>(); for (const v of vs) cnt.set(v.stage, (cnt.get(v.stage) ?? 0) + 1);
  const top = [...cnt].sort((a, b) => b[1] - a[1])[0][0];
  const pick = vs.find((v) => v.stage === top)!;
  return { id: pick.id, n: bad.length, stage: top, markers: pick.markers, line: `${pick.line}・外れ ${cnt.get(top)}/${bad.length}回` };
}

/** 連携の表の1行（作業員5の形・writes の印の名前で引く） */
export type LinkRow = { id: string; owner: string; files?: string[]; writes: string[] };
/** 仮の表（テスト用。本物は作業員5の連携の表 app/lib/conductor-linkage.ts） */
export const PROVISIONAL_LINKS: LinkRow[] = [
  { id: "two_stage", owner: "（仮）", files: ["app/lib/two-stage-*.ts"], writes: ["decision:two_stage", "two_stage:"] },
  { id: "scene_net", owner: "（仮）", files: ["app/lib/scene-*.ts"], writes: ["scene_net:"] },
];
/** 印 → 持ち主。既定は作業員5の連携の表（ownersOfMarker・一番長い一致）。table を渡した時はその表（前方一致・最初に当たった行） */
export function ownerOf(markers: string[], table?: LinkRow[]): LinkRow | null {
  if (table) { for (const mk of markers) for (const row of table) if (row.writes.some((w) => mk.startsWith(w))) return row; return null; }
  for (const mk of markers) { const hit = ownersOfMarker(mk)[0]; if (hit) return { id: hit.id, owner: hit.owner, files: hit.files, writes: hit.writes }; }
  return null;
}

/** brain_weaknesses に入れる1行の案（key は段＋印の頭＝同じ型の外れは同じ key で重なりを見る） */
export function weaknessDraft(s: { id: string; stage: MissStage; markers: string[]; line: string }, owner: LinkRow | null): { key: string; title: string; area: "exam" | "brain" | "writer"; root_cause: string; evidence: Record<string, unknown> } {
  const head = (s.markers[0] ?? "none").replace(/\(.*$/, "");
  return {
    key: `exam-stage:${s.stage}:${head}`,
    title: `試験の外れ: ${STAGE_JA[s.stage]}で道が変わる（${head}）`,
    area: s.stage === "writer" || s.stage === "final_check" ? "writer" : s.stage === "brain" ? "brain" : "exam",
    root_cause: `${s.line}${owner ? `・持ち主 ${owner.id}（${owner.owner}）` : "・持ち主は連携の表に無い"}`,
    evidence: { problem: s.id, markers: s.markers, owner: owner?.owner ?? null },
  };
}
