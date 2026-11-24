// app/lib/route-station-cells.ts — 申込までの地図の弱い駅を「駅 × 番の型 × 駅の中の状態」の升に細かく分け、竹内さん本人の一手の多い方がある升だけを直しの候補にする（純関数・DB/LLM なし・台帳 #650）
//
// 2026-11-24 作業員A（統括役の頼み・#650「一致が弱い所に土台を作り、駅ごとに細分化して強化（見積・内覧予定・審査の相談・入居時期が先など）」）。
//   決まり: 決まりにするのは n≥10 で過半数の形がある所だけ（memory の決まり）。升の n が足りない時は「n 不足」、割れていれば「割れ」と出し、推して直さない。
//   11/23 の ⑤（問いの番はまず答える）を監査で止めた前例（良くなった 4・悪くなった 17）があるので、升ごとに「地図の次の一手との一致」と「竹内さんの多い方」を並べる。
//   材料は R／A の audit-route-progress-takeuchi の json の行（駅 node・分かれ道 branch・番の型 rt・駅の中の状態 sub1・竹内さんの一手 act・地図の次の一手 nextAix・一致 agree）。
export type CellRow = { node: string | null; branch: string | null; rt?: string | null; sub1?: string | null; act: string; agree: string; nextAix?: string[] | null;
  /** 番の前の30日に送った AIX の種類 → 時刻（audit-route-progress の json・4aac0c382 から） */
  sentBefore?: Record<string, string> | null };
/** 送った物の段（審査の相談・見積の駅を割る軸）: 見積書を送った後か・確認の後か・物件を送った後か・まだか（sentBefore が無い行は「?」） */
export function sentStageOf(r: Pick<CellRow, "sentBefore">): string {
  const sb = r.sentBefore; if (!sb) return "?";
  if (sb.estimate_sheet) return "見積の後";
  if (sb.property_check_result) return "確認の後";
  if (sb.property_send || sb.property_recommendation) return "物件の後";
  return "送付なし";
}
export type CellVerdict = "candidate" | "already_ok" | "split" | "n_short";
export type StationCell = {
  station: string; rt: string; sub: string; n: number;
  /** 竹内さんの一手の多い方（AIX の種類・返信の締め）と割合 */
  top: { act: string; n: number; rate: number } | null;
  /** 地図の次の一手と合った番 */
  match: number;
  verdict: CellVerdict;
  /** candidate の時: 竹内さんの多い方を地図の次の一手にする案（aix＝AIX の種類・reply＝返信） */
  proposal?: { kind: "aix" | "reply"; act: string };
};
const GOOD = new Set(["aix_match", "promise_match", "reply_match", "reply_invite"]);
export const CELL_MIN_N = 10;
const stationOf = (r: Pick<CellRow, "node" | "branch">) => (r.branch ? `分:${r.branch}` : r.node ?? "?");
/** 一手のまとめ方: AIX は種類・返信は締めの型（reply:answer 等）のまま */
const actKey = (a: string) => (a.startsWith("aix:") ? a : a.startsWith("reply:") ? a : a);

/** 駅ごとに、番の型（rt）× 駅の中の状態（sub1）の升に分ける。split: "rt" だけ／"rt_sub" で両方 */
export function stationCellsOf(rows: ReadonlyArray<CellRow>, stations: ReadonlyArray<string>, split: "rt" | "rt_sub" | "rt_sent" = "rt", minN = CELL_MIN_N): StationCell[] {
  const by = new Map<string, CellRow[]>();
  for (const r of rows) {
    const st = stationOf(r); if (!stations.includes(st)) continue;
    const k = `${st}|${r.rt ?? "-"}|${split === "rt_sub" ? r.sub1 ?? "-" : split === "rt_sent" ? sentStageOf(r) : "*"}`;
    const a = by.get(k) ?? []; a.push(r); by.set(k, a);
  }
  const out: StationCell[] = [];
  for (const [k, rs] of by) {
    const [station, rt, sub] = k.split("|");
    const cnt = new Map<string, number>(); for (const r of rs) cnt.set(actKey(r.act), (cnt.get(actKey(r.act)) ?? 0) + 1);
    const [topAct, topN] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const n = rs.length, match = rs.filter((r) => GOOD.has(r.agree)).length;
    const top = topAct ? { act: topAct, n: topN, rate: Math.round((topN / n) * 1000) / 10 } : null;
    let verdict: CellVerdict;
    if (n < minN) verdict = "n_short";
    else if (match * 2 > n) verdict = "already_ok";
    else if (top && top.n * 2 > n) verdict = "candidate";
    else verdict = "split";
    out.push({ station, rt, sub, n, top, match, verdict, ...(verdict === "candidate" && top ? { proposal: { kind: top.act.startsWith("aix:") ? "aix" : "reply", act: top.act } } : {}) });
  }
  return out.sort((a, b) => a.station.localeCompare(b.station) || b.n - a.n);
}
/** 駅ごとのまとめ: 升の数・候補・割れ・n 不足 */
export function stationCellSummary(cells: ReadonlyArray<StationCell>): Array<{ station: string; n: number; cells: number; candidate: number; split: number; nShort: number; ok: number }> {
  const by = new Map<string, StationCell[]>();
  for (const c of cells) { const a = by.get(c.station) ?? []; a.push(c); by.set(c.station, a); }
  return [...by.entries()].map(([station, cs]) => ({ station, n: cs.reduce((s, c) => s + c.n, 0), cells: cs.length, candidate: cs.filter((c) => c.verdict === "candidate").length, split: cs.filter((c) => c.verdict === "split").length, nShort: cs.filter((c) => c.verdict === "n_short").length, ok: cs.filter((c) => c.verdict === "already_ok").length }));
}
