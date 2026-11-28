// scripts/lib/foundation-table.ts — 土台の表（決まり → 物差し → 本番の数字 → 担当の部品）の形と、作業員N の土台8つ（memory/foundation_eight_1121.md）
//
// 2026-11-21 作業員N（自己改善の芯 ① 土台が無い・統括役の頼み・台帳 #473）。check-foundation がこの形の表を全部読み、欠けた列を出す。
//   ほかの持ち主の表は memory/foundation_tables/<持ち主>.json に同じ形で置く（作業員K2 の AIX の表・作業員G の統括Pro の F）。
//   rules … 設計知見の id の頭8字（P0/P1 の決まり）／measures … 数える台本（scripts/ の名前）／metric … quality_daily の metric（毎日の数）／parts … 担当の部品のスイッチ
export type FoundationRow = { id: string; name: string; owner: string; rules: string[]; measures: string[]; metric: string | null; parts: string[]; note?: string;
  /** 2026-11-23 作業員N（台帳 #464）: 主の毎日の数がまだ書かれていない時に、同じ土台を測っている既にある数（どれか1つが7日に入っていれば本番の数字あり） */
  metricAlt?: string[] };

// 2026-11-23 統括役の決め（持ち主は今の4人・作業員A の受け持ち表も同じ）: 約束・時系列・統括の学び・信頼・つなぎ＝L／道筋・今どこ・要件＝A／決めに行く・気持ち・訴求＝P／臨機応変＝N2
export const FOUNDATION_N: FoundationRow[] = [
  { id: "n.flex", name: "臨機応変", owner: "作業員L", /* 2026-11-24 統括役: 2人体制で N2→L */ rules: ["3c744786", "ecd7b961"], measures: ["scripts/audit-off-pattern.ts"], metric: "growth:flex:off_rate", parts: [], note: "統括の行き先の3行の部品が無い（12/05 の数え直しの後）" },
  { id: "n.trust", name: "信頼", owner: "作業員L", rules: ["d71352cd", "aa21438c", "45110555"], measures: ["scripts/audit-promise-kept.ts", "scripts/audit-trust-b4b5.ts", "scripts/audit-trust-repeat.ts"], metric: "growth:trust:promise_kept", parts: ["CONDUCTOR_OVERDUE_PROMISES", "PROMISE_DROP_WATCH"] },
  { id: "n.feeling", name: "気持ち", owner: "作業員A", rules: ["c3b40411", "5cb0dd4c"], measures: ["scripts/audit-writer-linkage.ts"], metric: "writer_link:field:latent_kind:in_draft", parts: ["LATENT_FIVE", "BRAIN_CONCERN_SUBTOPIC"], note: "当たりの物差しは正解付け（#236）待ち", metricAlt: ["writer_link:field:latent_kind:delivered"] /* 2026-11-23 作業員N2: 名前の取り違えを直した（毎朝の1枚が書く名前は latent_kind・latent_feeling は1度も無い＝check-stale の「毎日の数が一度も無い」の元） */ },
  { id: "n.appeal", name: "訴求", owner: "作業員A", /* 2026-11-28 作業員A（台帳 #754）: 決まりは設計知見にあったが表につながっていなかった＝本文を読んで訴求の決まり（P1・現行）だけを入れた: aef0a1df 訴求のタイミングの1関数・a92b6655 遠方・内覧まで期間は申込で抑える・6bb6195c 内見に前向きな一言の受け方・59b45146 誘い方は場面の担当（日程は AIX）・21845b12 退去予定の内覧が1週間以内は申込で抑える */ rules: ["aef0a1df", "a92b6655", "6bb6195c", "59b45146", "21845b12"], measures: ["scripts/audit-appeal-points.ts", "scripts/audit-aix-edit-diff.ts", "scripts/audit-appeal-by-scene.ts"], metric: "growth:aix_edit:ピックアップ", parts: ["SECOND_APPEAL_COUNT_BY_SCENE", "APPEAL_RECORD"], note: "竹内さんの選び A（11/18）の KB の id を足す" },
  // 2026-11-22 作業員L（台帳 #501・#518）: 物差し＝時の言葉が帳面に届くか（audit-timeline-coverage・窓の内外）と、竹内さんの番の場面ごとの時の言葉への返し方（audit-time-reply-scene）。本番の数は作業員N2 が quality_daily に
  { id: "n.chrono", name: "時系列", owner: "作業員L", rules: ["b8dac051", "27aa2736"], measures: ["scripts/audit-timeline-coverage.ts", "scripts/audit-time-reply-scene.ts"], metric: "foundation:chrono:timeline_reach", parts: ["TIME_FACTS", "STALE_DAY_DRAFT_CLEAR"], note: "取り違えの台本 audit-chrono-mixup は未作成", metricAlt: ["writer_link:timeline:words:to_brain", "writer_link:timeline:promises:to_writer", "core:window_miss:timeline.customer"] },
  // 2026-11-22 作業員L（台帳 #502・#519）: audit-promise-kept は 11/21 #495 から場面ごとに数えている（SCENE_SPLIT へ）。本番の数は作業員N2 が quality_daily に
  { id: "n.promise", name: "約束", owner: "作業員L", rules: ["2b1e0044", "22c7e985", "19e34124", "5649fbee"], measures: ["scripts/audit-promise-kept.ts", "scripts/audit-promise-ledger.ts", "scripts/audit-promise-lifecycle.ts"], metric: "foundation:promise:kept_in_time", parts: ["CONDUCTOR_OVERDUE_PROMISES", "PROMISE_DROP_WATCH", "COND_PICKUP_SENT_FIRST", "PROMISE_KIND_WIDE2", "PROMISE_CONTACT_KIND"], metricAlt: ["promise_life:kept_in_time", "promise_life:find_miss", "foundation:promise:kept_72h", "foundation:promise:overdue_rate", "foundation:promise:open", "promise:kept_true", "map:promise:kept_true:value"] },
  { id: "n.asks", name: "要件", owner: "作業員A", rules: ["ca55d42b", "aa21438c"], measures: ["scripts/ask-ledger-score.ts", "scripts/audit-ask-route-takeuchi.ts"], metric: "growth:ask:合う", parts: ["ASK_LEDGER", "ASK_PROGRESS"], note: "本番の meta.ask_ledger を数える台本は未作成" },
  { id: "n.link", name: "つなぎ", owner: "作業員L", rules: ["82d5dd50", "69491851", "59b45146"], measures: ["scripts/tsunagi-census.ts", "scripts/audit-guide.ts", "scripts/audit-link-brain.ts"], metric: "foundation:link:tsunagi_rate", /* 2026-11-23 作業員N2: 毎朝の1枚が tsunagi-census --days=30 から書く（scope takeuchi） */ parts: ["NEXT_SEND_LINK", "TSUNAGI_ONE_PLACE"] },
  // 2026-11-23 作業員N2（台帳 #505・竹内さんの決定 0f38f47f の型「土台→細分化→物差し→弱い所を自動で見つけて直す→統括につなぐ」）: 統括の受け持ち表
  //   （作業員A の scripts/lib/conductor-duty.ts の土台12）と id・名前を揃えて、表に無かった4つを足した。物差し・毎日の数は今日できた数（作業員P の地図の根・作業員R・A の台本）
  { id: "route.path", name: "道筋（申込までの地図）", owner: "作業員A", rules: ["2d1c4c74", "f64e0f5d", "54d1370e"], measures: ["scripts/audit-route-progress-takeuchi.ts"], metric: "route:progress_60d", parts: ["ROUTE_DIGEST"],
    metricAlt: ["map:route:progress_60d:value", "route:sg_match", "map:route:next_match_60d:value"], note: "地図は道筋（一手はブレイン・KB 2d1c4c74）。弱い駅は地図の穴として台帳へ（self-improve）" },
  { id: "route.now", name: "今どこ", owner: "作業員A", rules: ["3907f365", "9f674d62"], measures: ["scripts/audit-route-progress-takeuchi.ts"], metric: "route:substate_mismatch_v2", parts: [],
    metricAlt: ["route:sg_match", "map:route:next_match_60d:value"], note: "駅の中の状態の読み違い（0 に向かう）・駅の記録との一致（sg の時代）" },
  { id: "n.closing", name: "決めに行く", owner: "作業員A", /* 2026-11-24 統括役: 2人体制で P→A（#658） */ rules: [], measures: ["scripts/audit-closing-takeuchi.ts"], metric: "route:closing", parts: [],
    metricAlt: ["map:route:closing:value", "route:closing_early", "map:route:closing_early:value"], note: "竹内さんの P0（11/23・#658）の KB の id を足す" },
  // 2026-11-26 作業員L（台帳 #505・統括役の頼み）: L が作った土台を帳面に（約束の一生の表は n.promise に足した・成約データの流れ・入口の届き・書き手への届き）
  { id: "l.dealflow", name: "成約データの流れ（申込までの実際の道）", owner: "作業員L", rules: [], measures: ["scripts/audit-deal-flow.ts", "scripts/audit-deal-conv-read.ts", "scripts/audit-deal-condition-gap.ts"], metric: null,
    parts: ["DEAL_STAGE_BEFORE_APPLY", "DEAL_APPLY_FORM_SEARCH_GUARD", "CONDUCTOR_DEAL_FLOW_LINE", "DEAL_FLOW_PRE_APPLY_LINE"], note: "竹内さん 11/25「地図は成約データから分析して流れ完全に理解できているのか」（#728）。決まり（KB）と毎日の数がまだ無い＝竹内さんの言葉を KB にする・deal_outcomes の作り直しの後に駅ごとの到達率を毎日の数に" },
  { id: "l.intake_reach", name: "統括の入口がブレインに届く", owner: "作業員L", rules: [], measures: ["scripts/audit-conductor-intake-reach.ts"], metric: "core:intake_reach:in_time",
    parts: ["CONDUCTOR_INTAKE_MAX_TOKENS_WIDE", "MATERIAL_PRIORITY", "CONDUCTOR_INTAKE_REUSE_PREV"], note: "竹内さん 11/25「統括ブレインなぜできるようになっていないのか・連携が弱いのかな？」（#747・#749）。決まり（KB）の id を足す" },
  { id: "l.writer_reach", name: "統括の決めが書き手に届く", owner: "作業員L", rules: [], measures: ["scripts/audit-writer-linkage.ts", "scripts/audit-writer-field-takeuchi.ts", "scripts/audit-timeline-delivery.ts"], metric: "growth:writer_link:delivered",
    metricAlt: ["growth:writer_link:in_draft", "growth:writer_link:brief_used"], parts: ["COMPOSE_BRIEF_ROLES", "SITUATION_WRITER_NOTE", "COMPOSE_DECIDED"], note: "台帳 #466。作っていない欄（配線が無い・スイッチ off）は分母から外す（11/26）。決まり（KB）の id を足す" },
  { id: "n.lessons", name: "統括の学び", owner: "作業員L", rules: [], measures: ["scripts/audit-conductor-duty.ts", "scripts/exam-leaf.ts"], metric: "core:conductor_duty:use", parts: ["CONDUCTOR_LESSONS"],
    metricAlt: ["core:conductor_duty:have", "core:conductor_duty:reflect"], note: "学びが地図の葉を指す印（exam-leaf --lessons）で地図の穴の『統括に届いているか』の学びの道になる" },
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
