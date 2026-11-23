// scripts/lib/foundation-table.ts — 土台の表（決まり → 物差し → 本番の数字 → 担当の部品）の形と、作業員N の土台8つ（memory/foundation_eight_1121.md）
//
// 2026-11-21 作業員N（自己改善の芯 ① 土台が無い・統括役の頼み・台帳 #473）。check-foundation がこの形の表を全部読み、欠けた列を出す。
//   ほかの持ち主の表は memory/foundation_tables/<持ち主>.json に同じ形で置く（作業員K2 の AIX の表・作業員G の統括Pro の F）。
//   rules … 設計知見の id の頭8字（P0/P1 の決まり）／measures … 数える台本（scripts/ の名前）／metric … quality_daily の metric（毎日の数）／parts … 担当の部品のスイッチ
export type FoundationRow = { id: string; name: string; owner: string; rules: string[]; measures: string[]; metric: string | null; parts: string[]; note?: string;
  /** 2026-11-23 作業員N（台帳 #464）: 主の毎日の数がまだ書かれていない時に、同じ土台を測っている既にある数（どれか1つが7日に入っていれば本番の数字あり） */
  metricAlt?: string[] };

export const FOUNDATION_N: FoundationRow[] = [
  { id: "n.flex", name: "臨機応変", owner: "作業員N", rules: ["3c744786", "ecd7b961"], measures: ["scripts/audit-off-pattern.ts"], metric: "growth:flex:off_rate", parts: [], note: "統括の行き先の3行の部品が無い（12/05 の数え直しの後）" },
  { id: "n.trust", name: "信頼", owner: "作業員N・作業員L", rules: ["d71352cd", "aa21438c", "45110555"], measures: ["scripts/audit-promise-kept.ts", "scripts/audit-trust-b4b5.ts", "scripts/audit-trust-repeat.ts"], metric: "growth:trust:promise_kept", parts: ["CONDUCTOR_OVERDUE_PROMISES", "PROMISE_DROP_WATCH"] },
  { id: "n.feeling", name: "気持ち", owner: "作業員K2・作業員L", rules: ["c3b40411", "5cb0dd4c"], measures: ["scripts/audit-writer-linkage.ts"], metric: "writer_link:field:latent_feeling:in_draft", parts: ["LATENT_FIVE", "BRAIN_CONCERN_SUBTOPIC"], note: "当たりの物差しは正解付け（#236）待ち" },
  { id: "n.appeal", name: "訴求", owner: "作業員K2", rules: [], measures: ["scripts/audit-appeal-points.ts", "scripts/audit-aix-edit-diff.ts"], metric: "growth:aix_edit:ピックアップ", parts: ["SECOND_APPEAL_COUNT_BY_SCENE", "APPEAL_RECORD"], note: "竹内さんの選び A（11/18）の KB の id を足す" },
  // 2026-11-22 作業員L（台帳 #501・#518）: 物差し＝時の言葉が帳面に届くか（audit-timeline-coverage・窓の内外）と、竹内さんの番の場面ごとの時の言葉への返し方（audit-time-reply-scene）。本番の数は作業員N2 が quality_daily に
  { id: "n.chrono", name: "時系列", owner: "作業員L", rules: ["b8dac051", "27aa2736"], measures: ["scripts/audit-timeline-coverage.ts", "scripts/audit-time-reply-scene.ts"], metric: "foundation:chrono:timeline_reach", parts: ["TIME_FACTS", "STALE_DAY_DRAFT_CLEAR"], note: "取り違えの台本 audit-chrono-mixup は未作成", metricAlt: ["writer_link:timeline:words:to_brain", "writer_link:timeline:promises:to_writer", "core:window_miss:timeline.customer"] },
  // 2026-11-22 作業員L（台帳 #502・#519）: audit-promise-kept は 11/21 #495 から場面ごとに数えている（SCENE_SPLIT へ）。本番の数は作業員N2 が quality_daily に
  { id: "n.promise", name: "約束", owner: "作業員L", rules: ["2b1e0044", "22c7e985", "19e34124", "5649fbee"], measures: ["scripts/audit-promise-kept.ts", "scripts/audit-promise-ledger.ts"], metric: "foundation:promise:kept_in_time", parts: ["CONDUCTOR_OVERDUE_PROMISES", "PROMISE_DROP_WATCH", "COND_PICKUP_SENT_FIRST"], metricAlt: ["foundation:promise:kept_72h", "foundation:promise:overdue_rate", "foundation:promise:open"] },
  { id: "n.asks", name: "要件", owner: "作業員M", rules: ["ca55d42b", "aa21438c"], measures: ["scripts/ask-ledger-score.ts", "scripts/audit-ask-route-takeuchi.ts"], metric: "growth:ask:合う", parts: ["ASK_LEDGER", "ASK_PROGRESS"], note: "本番の meta.ask_ledger を数える台本は未作成" },
  { id: "n.link", name: "つなぎ", owner: "作業員H・作業員L", rules: ["82d5dd50", "69491851", "59b45146"], measures: ["scripts/tsunagi-census.ts", "scripts/audit-guide.ts", "scripts/audit-link-brain.ts"], metric: null, parts: ["NEXT_SEND_LINK", "TSUNAGI_ONE_PLACE"] },
];

export type FoundationGap = { id: string; name: string; owner: string; missing: Array<"rules" | "measures" | "metric" | "parts">; detail: string };
/** 欠けた列（純関数）。台本が無い・数が7日入っていない・スイッチがコードに無い時も欠けとみる */
export function foundationGapsOf(rows: ReadonlyArray<FoundationRow>, o: { scriptExists: (p: string) => boolean; metricSeen: (m: string) => boolean; switchKnown: (s: string) => boolean }): FoundationGap[] {
  const out: FoundationGap[] = [];
  for (const r of rows) {
    const miss: FoundationGap["missing"] = [];
    const why: string[] = [];
    if (!r.rules.length) { miss.push("rules"); why.push("決まり（KB）が無い"); }
    const ms = r.measures.filter((m) => o.scriptExists(m));
    if (!ms.length) { miss.push("measures"); why.push(r.measures.length ? `台本が見つからない（${r.measures.join("・")}）` : "物差しの台本が無い"); }
    if ((!r.metric || !o.metricSeen(r.metric)) && !(r.metricAlt ?? []).some((m) => o.metricSeen(m))) { miss.push("metric"); why.push(r.metric ? `毎日の数 ${r.metric} が7日入っていない` : "毎日の数（quality_daily）が無い"); }
    const ps = r.parts.filter((p) => o.switchKnown(p));
    if (!ps.length) { miss.push("parts"); why.push(r.parts.length ? `部品のスイッチがコードに無い（${r.parts.join("・")}）` : "担当の部品が無い"); }
    if (miss.length) out.push({ id: r.id, name: r.name, owner: r.owner, missing: miss, detail: [...why, r.note ?? ""].filter(Boolean).join("／") });
  }
  return out;
}
