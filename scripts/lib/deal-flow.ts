// scripts/lib/deal-flow.ts — 成約データ（deal_outcomes）の段の時刻から、申込までの実際の流れを数える（純関数・LLM なし・台帳 #728・2026-11-25 作業員L）
//   竹内さん 11/25「地図は成約データから分析して流れ完全に理解できているのか？」「ここ徹底的に強化する・土台ちゃんと整えて細分化して強化していく」
//   段（時刻のある物だけ）: 初回 first_contact_at → 条件 condition_at → 物件送り property_sent_at → 見積（aix_usage_logs の estimate_sheet・estimate_records の最初）
//     → 内覧の日時 viewing_at → 内覧した viewing_held_at → 申込 applied_at → 成約 won_at。申込以降・審査の中身は読まない（時刻だけ）
//   地図（app/lib/apply-route-map.ts）の駅に当てる: inquiry・hearing・proposing・estimate・viewing_scheduled・viewed・applying・won
//     （pickup・interested・viewing_arrange・apply_prep は時刻の列が無い＝その前後の段から通ったとみる）
//   外れの分け（作業員A の #687 と同じ名前）: no_road＝地図に道が無い（例: 内覧なしで申込）・order＝地図と順番が違う（見積が内覧より後 等）・
//     record_missing＝記録の抜け（申込したのに条件・物件送りの時刻が無い・内覧したのに内覧の日時が無い・成約なのに申込の時刻が無い）
export type DealRow = {
  id: number; conversation_id: string; first_contact_at?: string | null; condition_at?: string | null; property_sent_at?: string | null;
  viewing_at?: string | null; viewing_held_at?: string | null; applied_at?: string | null; won_at?: string | null; estimate_at?: string | null;
};
export const FLOW_STAGES = [
  { key: "first_contact_at", ja: "初回", station: "inquiry" },
  { key: "condition_at", ja: "条件", station: "hearing" },
  { key: "property_sent_at", ja: "物件送り", station: "proposing" },
  { key: "estimate_at", ja: "見積", station: "estimate" },
  { key: "viewing_at", ja: "内覧の日時", station: "viewing_scheduled" },
  { key: "viewing_held_at", ja: "内覧した", station: "viewed" },
  { key: "applied_at", ja: "申込", station: "applying" },
  { key: "won_at", ja: "成約", station: "won" },
] as const;
export type StageKey = (typeof FLOW_STAGES)[number]["key"];
/** 地図の駅の順（apply-route-map の nextNode の鎖と同じ順・時刻の列のある駅だけ） */
export const MAP_ORDER: readonly string[] = FLOW_STAGES.map((s) => s.station);
export type GapKind = "no_road" | "order" | "record_missing";

export type DealFlow = {
  id: number; applied: boolean; won: boolean;
  /** 時刻の順に並べた段（同じ時刻は地図の順） */
  path: string[];
  /** 隣どうしの段の間の日数 */
  gaps: Array<{ from: string; to: string; days: number }>;
  skipped: string[]; backward: Array<{ from: string; to: string }>;
  stations: string[]; issues: Array<{ kind: GapKind; why: string }>;
};

const ms = (v?: string | null) => (v ? Date.parse(v) : NaN);
export function dealFlowOf(r: DealRow): DealFlow {
  const have = FLOW_STAGES.map((s, i) => ({ ...s, i, t: ms(r[s.key as StageKey]) })).filter((x) => Number.isFinite(x.t));
  const ord = [...have].sort((a, b) => a.t - b.t || a.i - b.i);
  const path = ord.map((x) => x.ja);
  const gaps = ord.slice(1).map((x, k) => ({ from: ord[k].ja, to: x.ja, days: Math.round(((x.t - ord[k].t) / 864e5) * 10) / 10 }));
  const backward: DealFlow["backward"] = [];
  for (let k = 1; k < ord.length; k++) if (ord[k].i < ord[k - 1].i) backward.push({ from: ord[k - 1].ja, to: ord[k].ja });
  const applied = Number.isFinite(ms(r.applied_at)), won = Number.isFinite(ms(r.won_at));
  const last = applied ? FLOW_STAGES.findIndex((s) => s.key === "applied_at") : Math.max(-1, ...have.map((x) => x.i));
  const skipped = FLOW_STAGES.slice(0, Math.max(0, last)).filter((s) => !Number.isFinite(ms(r[s.key as StageKey]))).map((s) => s.ja);
  const issues: DealFlow["issues"] = [];
  const has = (k: StageKey) => Number.isFinite(ms(r[k]));
  if (applied && !has("viewing_held_at")) issues.push({ kind: "no_road", why: "内覧なしで申込（地図は 内覧後 → 申込準備 の道だけ）" });
  if (has("viewing_held_at") && !has("viewing_at")) issues.push({ kind: "record_missing", why: "内覧したのに内覧の日時の記録が無い" });
  if (applied && !has("property_sent_at")) issues.push({ kind: "record_missing", why: "申込したのに物件送りの記録が無い（持ち込みの物件か送付の記録の抜け）" });
  if (applied && !has("condition_at")) issues.push({ kind: "record_missing", why: "申込したのに条件の時刻が無い" });
  if (won && !applied) issues.push({ kind: "record_missing", why: "成約なのに申込の時刻が無い" });
  for (const b of backward) issues.push({ kind: "order", why: `地図と順番が違う（${b.from} の後に ${b.to}）` });
  return { id: r.id, applied, won, path, gaps, skipped, backward, stations: ord.map((x) => x.station), issues };
}

/** 型（段の並び）ごと・申込に届いたかで数える */
export function flowTypes(fs: readonly DealFlow[]): Array<{ type: string; n: number; applied: number; won: number; medDays: number | null }> {
  const by = new Map<string, DealFlow[]>();
  for (const f of fs) { const k = f.path.join("→") || "（段なし）"; by.set(k, [...(by.get(k) ?? []), f]); }
  const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return [...by].map(([type, xs]) => ({ type, n: xs.length, applied: xs.filter((x) => x.applied).length, won: xs.filter((x) => x.won).length, medDays: med(xs.map((x) => x.gaps.reduce((a, g) => a + g.days, 0))) }))
    .sort((a, b) => b.applied - a.applied || b.n - a.n);
}

/** 駅ごとの申込到達率（その駅を通った件のうち申込に届いた割合）。時刻の無い駅（pickup 等）は前後の段から通ったとみる */
export function stationReach(fs: readonly DealFlow[]): Array<{ station: string; n: number; applied: number; rate: number | null }> {
  const implied: Record<string, (f: DealFlow) => boolean> = {
    pickup: (f) => f.stations.includes("proposing"),
    // 申込だけでは「気に入った」とみない（申込に届いた件を全部入れると到達率がかさ上げになる）
    interested: (f) => f.stations.some((s) => ["estimate", "viewing_scheduled", "viewed"].includes(s)),
    viewing_arrange: (f) => f.stations.some((s) => ["viewing_scheduled", "viewed"].includes(s)),
    apply_prep: (f) => f.applied,
  };
  const order = ["inquiry", "hearing", "pickup", "proposing", "interested", "estimate", "viewing_arrange", "viewing_scheduled", "viewed", "apply_prep", "applying", "won"];
  return order.map((st) => {
    const pass = fs.filter((f) => (implied[st] ? implied[st](f) : f.stations.includes(st)));
    const applied = pass.filter((f) => f.applied).length;
    return { station: st, n: pass.length, applied, rate: pass.length ? Math.round((applied / pass.length) * 1000) / 10 : null };
  });
}
