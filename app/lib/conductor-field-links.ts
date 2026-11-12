// app/lib/conductor-field-links.ts — 欄ごとの連携の表（作る所→受け取る所・欄の名前の語彙ファイル・道の前か後か・スイッチ）（純関数・データだけ・作業員22・2026-11-12）
//
// 竹内さん 11/12「ちゃんと各ブレインとの連携もできるように細かい部分をこだわって細分化していく」（統括役・親 P0 575a7cd5・P1 3381edd8 統括同士の連携の表）。
//   conductor-linkage.ts（統括ごとの表・作業員7 が決め直しの勝ち負けの表を足している最中）は統括の単位。この表は「欄」の単位で、今日できた部品全部を並べる。
//   1行＝1つの欄: 作る所（どのブレイン・どの欄）→ 受け取る所 → 欄の名前の語彙ファイル → 道の前か後か（材料か）→ スイッチ → 今どこに入っているか（main か作業員のブランチか）。
// テスト（scripts/test-conductor-field-links.ts）で落とす物: ①作られたのに誰も受け取らない欄 ②受け取る所があるのに作る所が無い欄
//   ③同じ物を2つの名前で持っている欄（同じ concept を2行が持つ時は bridge＝読み替えの関数が要る）④道の前に置いてはいけない欄（次の一手・優先・目的・押す強さ）が前にある。
//   main に入っていない欄（where が main でない）は、表の形だけ確かめ、コードとの突き合わせ（BRAIN_FIELD_ROUTE 等）は main に入った順に強める。

/** 受け取る所（統括の段の名前・conductor-linkage の id と揃える物は同じ名前） */
export const RECEIVERS = [
  "intake",       // 入口の統括（表→背景→重点）
  "brain",        // 判断のブレイン（材料として読む）
  "conductor",    // 統括の記録（型・配分・指示書・疑いの印）
  "compose",      // 文の統括（設計図・作業員10）
  "writer",       // 書き手（generate-reply）
  "aix_desk",     // AIX の統括（どの AIX・ピッカー）
  "aix_text",     // AIX の文
  "send_combo",   // 返信と AIX の組と順番（作業員7）
  "final_check",  // 最終チェック
  "measure",      // 物差し・試験の採点（費用0の道具）
  "shadow_auto",  // 影の自動返信（作業員1 の場面の集計）
] as const;
export type Receiver = typeof RECEIVERS[number];

export type FieldPlace =
  | "material"        // ブレインに渡す材料（事実の一覧・道の言葉なし）
  | "before_route"    // ブレインの出力のうち道（返信か AIX か）より前に書く事実の欄
  | "after_route"     // 道を書き終えた後の欄（JSON の最後・記録）
  | "post";           // ブレインの後で決まった計算が作る記録（meta に足す）

export type FieldLink = {
  /** 欄の名前（meta の鍵・材料なら材料の名前） */
  field: string;
  /** 何を持つ欄か（同じ物を2つの名前で持っていないかを見る鍵） */
  concept: string;
  /** 作る所（ブレイン・関数） */
  producer: string;
  owner: string;
  /** 受け取る所（無ければ [] ＝ テストで落ちる。記録だけの欄も measure か conductor を書く） */
  receivers: Receiver[];
  /** 欄の名前の語彙ファイル */
  vocab: string;
  place: FieldPlace;
  /** 道を引っぱる中身（次の一手・優先・目的・押す強さ・誘導）を持つか。true の欄は before_route に置けない（q406・q057・q065・q022） */
  steers: boolean;
  switch: string;
  /** 今どこに入っているか（"main" か作業員のブランチ名） */
  where: string;
  /** 同じ concept を別の名前で持つ欄との読み替え（関数名）。無いと ③ で落ちる */
  bridge?: string;
  /** meta の鍵（SuggestedAixMeta にある欄）。あれば compose-sentence-plan の BRAIN_FIELD_ROUTE と突き合わせる（plan なら受け取る所に compose が要る） */
  metaKey?: string;
  note?: string;
};

export const FIELD_LINKS: readonly FieldLink[] = [
  { field: "now_vs_later", metaKey: "now_vs_later", concept: "今の番の出力と後で果たす物", producer: "brain（JSON の最初の事実の欄）", owner: "作業員16", receivers: ["brain", "conductor"], vocab: "app/lib/brain-now-later.ts", place: "before_route", steers: false, switch: "BRAIN_NOW_LATER_FIRST", where: "feat/our-send-uptake-1112", note: "ready_now は check-order-wire の resultReady・our_open は pendingPromise" },
  { field: "aix_now", metaKey: "aix_now", concept: "今届ける AIX（now_vs_later から）", producer: "brain-core aixNowOf", owner: "作業員16", receivers: ["measure"], vocab: "app/lib/brain-now-later.ts", place: "post", steers: false, switch: "BRAIN_NOW_LATER_FIRST", where: "feat/our-send-uptake-1112" },
  { field: "read_candidates", metaKey: "read_candidates", concept: "一通の読みの候補", producer: "brain（事実の欄）", owner: "作業員16", receivers: ["conductor", "measure"], vocab: "app/lib/brain-read-candidates.ts", place: "before_route", steers: false, switch: "BRAIN_READ_CANDIDATES", where: "feat/our-send-uptake-1112", note: "check-order-wire（ackOnly・customerSentProperty・firstContact）・conductor-doubt（読み違い・自信の印）が読む" },
  { field: "our_send_uptake", metaKey: "our_send_uptake", concept: "こちらの直前の送信の受け取られ方（刺さり）", producer: "brain（事実の欄）", owner: "作業員16", receivers: ["conductor"], vocab: "app/lib/our-send-uptake.ts", place: "before_route", steers: false, switch: "BRAIN_OUR_SEND_UPTAKE", where: "feat/our-send-uptake-1112", note: "check-order-wire の hooked・conductor-doubt の押す強さの上限（notHooked）" },
  { field: "info_fill", concept: "足りない情報（申込までに要る情報の埋まり）", producer: "brain-core（info-fill-map.infoFillForNode）", owner: "作業員1", receivers: ["brain", "conductor"], vocab: "app/lib/info-fill-map.ts（INFO_KEYS）", place: "material", steers: false, switch: "INFO_FILL_MAP（CONDUCTOR_BRIEF でも作る）", where: "w1-exh-1112", note: "judge_basis.missing の名前もここ" },
  { field: "exchange_ledger", concept: "照らし合わせの残り（答えてもらっていない・果たしていない）", producer: "exchange-ledger.buildExchangeLedger", owner: "作業員4", receivers: ["intake", "brain", "conductor"], vocab: "app/lib/exchange-ledger.ts（OPEN_KINDS）", place: "material", steers: false, switch: "CONDUCTOR_EXCHANGE_LEDGER・_BRAIN（CONDUCTOR_BRIEF でも作る）", where: "main" },
  { field: "our_part", concept: "こちらの送信の部分（約束・問い・事実）", producer: "our-part-types.splitOurPartsFine", owner: "作業員4", receivers: ["conductor"], vocab: "app/lib/our-part-types.ts（OUR_PARTS）", place: "material", steers: false, switch: "（exchange_ledger と同じ）", where: "main", note: "conductor-doubt の約束の重ね" },
  { field: "customer_part", concept: "お客様の一通の部分（主の要件）", producer: "customer-part-types.splitCustomerParts", owner: "作業員21", receivers: ["conductor"], vocab: "app/lib/customer-part-types.ts（CUSTOMER_PART_KINDS）", place: "material", steers: false, switch: "CUSTOMER_PART_TYPES", where: "feat/info-kind-1112（未コミット）", note: "指示書の主の要件（今は turn_contract.asks で代わり・未）" },
  { field: "customer_part.info", concept: "問いが求める情報の種類", producer: "customer-part-types QUESTION_POINTS.info", owner: "作業員21", receivers: ["conductor"], vocab: "app/lib/aix-catalog-map.ts（INFO_KINDS_16・K1〜K16）", place: "material", steers: false, switch: "CUSTOMER_PART_TYPES", where: "feat/info-kind-1112（未コミット）", bridge: "未（INFO_KEYS と K1〜K16 の読み替えの表が要る）", note: "③ 情報の名前が INFO_KEYS（13）と INFO_KINDS_16（16）の2つ" },
  { field: "check_order", concept: "判断の順番の型（型・確認の順番・なぜ）", producer: "check-order-wire.checkOrderRecord（pickCheckOrder）", owner: "作業員16（表）・作業員22（配線）", receivers: ["conductor", "send_combo"], vocab: "app/lib/check-order.ts（CHECK_ORDER_TYPES・CheckStep）", place: "post", steers: false, switch: "CHECK_ORDER_TABLE", where: "feat/judge-basis-purpose-1112", metaKey: "check_order", note: "作業員10 の文の型の表が読む時に compose を足し BRAIN_FIELD_ROUTE を plan に" },
  { field: "conductor_allocation", concept: "番ごとの部品の配分", producer: "conductor-allocation.allocationFromMeta", owner: "作業員22", receivers: ["conductor", "measure"], vocab: "app/lib/conductor-allocation.ts（PARTS＝FOCUS_ORDER の役）", place: "post", steers: false, switch: "CONDUCTOR_ALLOCATION", where: "feat/judge-basis-purpose-1112" },
  { field: "judge_basis", metaKey: "judge_basis", concept: "判断の根拠のメモ（深さ・優先・目的・足りない情報・要点・順番）", producer: "brain（JSON の最後）", owner: "作業員22（17 から）", receivers: ["measure", "conductor"], vocab: "app/lib/judge-basis-types.ts", place: "after_route", steers: true, switch: "BRAIN_JUDGE_BASIS", where: "main（名前の合わせ直しは feat/judge-basis-purpose-1112）" },
  { field: "judge_basis.depth", concept: "読む深さ", producer: "brain（judge_basis.depth）", owner: "作業員22", receivers: ["conductor", "measure"], vocab: "app/lib/judge-basis-types.ts（DEPTH_KINDS＝shallow|normal|deep）", place: "after_route", steers: false, switch: "BRAIN_JUDGE_BASIS", where: "main", bridge: "conductor-allocation.normDepth", note: "brain_depth.depth（light|normal|deep）と同じ物" },
  { field: "brain_depth", concept: "読む深さ", producer: "brain-depth（決まった計算）", owner: "作業員4", receivers: ["brain", "conductor"], vocab: "app/lib/brain-depth.ts（light|normal|deep）", place: "material", steers: false, switch: "BRAIN_DEEP_RECHECK", where: "main", bridge: "conductor-allocation.normDepth" },
  { field: "seven_read", metaKey: "seven_read", concept: "竹内さんの7つの欄（本番の番の読み）", producer: "brain（JSON の最後）", owner: "作業員10", receivers: ["compose"], vocab: "app/lib/takeuchi-seven-read.ts", place: "after_route", steers: true, switch: "BRAIN_SEVEN_FIELDS", where: "main" },
  { field: "latent_read", metaKey: "latent_read", concept: "潜在の4欄", producer: "brain（JSON の最後）", owner: "作業員10", receivers: ["compose"], vocab: "app/lib/takeuchi-seven-read.ts（LatentFour）", place: "after_route", steers: true, switch: "BRAIN_SEVEN_FIELDS", where: "main", note: "作業員24 の根A: Handoff にまだ入っていない" },
  { field: "next_move", concept: "次の一手（行き先×強さ×時機）", producer: "next-move-types（型の表 NEXT_MOVE_OF_TYPE・返信の文からの網）", owner: "作業員16（表）・作業員7（具体）", receivers: ["conductor", "send_combo", "measure"], vocab: "app/lib/next-move-types.ts（NEXT_DEST・NEXT_STRENGTH）", place: "post", steers: true, switch: "（表だけ・どこからも道の前に読まない）", where: "main" },
  { field: "send_combo", concept: "返信と AIX の組と順番", producer: "send-combo-table.sendComboRecord", owner: "作業員7", receivers: ["conductor", "measure"], vocab: "app/lib/send-combo-table.ts（SendCombo）", place: "post", steers: false, switch: "SEND_COMBO_TABLE", where: "w7-seq（feat/send-seq 系・699f2986）", note: "指示書の組と順番は今は meta.two_message_plan_digest（作業員7 の two-message-plan）を読む" },
  { field: "two_message_plan", concept: "何通・どの順・各通の受け持ち", producer: "conductor-combine.combineFromMeta", owner: "作業員7", receivers: ["compose", "writer", "conductor"], vocab: "app/lib/two-message-plan.ts", place: "post", steers: false, switch: "CONDUCTOR_COMBINE", where: "main" },
  { field: "time_facts", concept: "時間の事実（今・曜日・祝日・営業・経過・期限）", producer: "time-facts.ts", owner: "作業員19", receivers: ["brain", "conductor"], vocab: "app/lib/time-facts.ts", place: "material", steers: false, switch: "TIME_FACTS", where: "feat/time-facts-1112", note: "conductor-doubt の時間の線は今は analyzed_msg_ts の JST 時だけ（入ったら time-facts の営業の線に寄せる）" },
  { field: "company_fact_proactive", concept: "先回りの会社の事実", producer: "brain-core（COMPANY_FACT_PROACTIVE）", owner: "作業員21", receivers: ["brain"], vocab: "app/lib/company-facts.ts", place: "material", steers: false, switch: "COMPANY_FACT_PROACTIVE", where: "feat/info-kind-1112（4fbc114b）" },
  { field: "customer_mindset", metaKey: "customer_mindset", concept: "お客様の状態・不安の向き・迷い・決め手の残り", producer: "brain（mindset・MINDSET_FRESH_READ で読み直し）", owner: "作業員21", receivers: ["compose", "conductor"], vocab: "app/lib/customer-mindset.ts（MINDSET_STATES・ANXIETY_TARGETS）", place: "before_route", steers: false, switch: "CUSTOMER_MINDSET・MINDSET_FRESH_READ", where: "main（読み直しは feat/info-kind-1112）", note: "conductor-doubt・check-order-wire の takenWorry（先に取られる）" },
  { field: "conductor_brief", metaKey: "conductor_brief", concept: "統括の指示書（具体の一覧・疑いの印・確かさ）", producer: "conductor-brief.buildConductorBrief", owner: "作業員22", receivers: ["conductor", "measure", "shadow_auto"], vocab: "app/lib/conductor-brief.ts・app/lib/conductor-doubt.ts", place: "post", steers: false, switch: "CONDUCTOR_BRIEF", where: "feat/judge-basis-purpose-1112", note: "shadow_auto は作業員1 の場面の集計が sure.handoff を読む時（案）" },
];

/** 道の前に置いてよい欄の考え: 事実と読みだけ（steers=false）。steers=true（次の一手・優先・目的・押す強さ・誘導）は道を書き終えた後か、ブレインの後の記録 */
export function placeViolations(rows: ReadonlyArray<FieldLink> = FIELD_LINKS): string[] {
  return rows.filter((r) => r.steers && (r.place === "before_route" || r.place === "material")).map((r) => r.field);
}
/** ① 作られたのに誰も受け取らない欄 */
export function orphanFields(rows: ReadonlyArray<FieldLink> = FIELD_LINKS): string[] {
  return rows.filter((r) => !r.receivers.length).map((r) => r.field);
}
/** ② 受け取る所があるのに作る所が無い欄（producer が空） */
export function producerlessFields(rows: ReadonlyArray<FieldLink> = FIELD_LINKS): string[] {
  return rows.filter((r) => r.receivers.length && !r.producer.trim()).map((r) => r.field);
}
/** ③ 同じ物を2つの名前で持っている欄（同じ concept の行の中に bridge の無い行がある）。bridge が「未」で始まる物も数える */
export function duplicateConcepts(rows: ReadonlyArray<FieldLink> = FIELD_LINKS): Array<{ concept: string; fields: string[]; noBridge: string[] }> {
  const by = new Map<string, FieldLink[]>();
  for (const r of rows) by.set(r.concept, [...(by.get(r.concept) ?? []), r]);
  const out: Array<{ concept: string; fields: string[]; noBridge: string[] }> = [];
  for (const [concept, rs] of by) {
    if (rs.length < 2) continue;
    const noBridge = rs.filter((r) => !r.bridge || r.bridge.startsWith("未")).map((r) => r.field);
    if (noBridge.length) out.push({ concept, fields: rs.map((r) => r.field), noBridge });
  }
  // bridge が「未」の行は concept が1つでも数える（別の語彙と読み替えが無い）
  for (const r of rows) if (r.bridge?.startsWith("未") && !out.some((o) => o.fields.includes(r.field))) out.push({ concept: r.concept, fields: [r.field], noBridge: [r.field] });
  return out;
}
