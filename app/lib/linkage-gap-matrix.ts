// app/lib/linkage-gap-matrix.ts — 連携の切れ目の全体の一覧（出す側 × 受け取る側・値打ちの順）（竹内さん 11/26「ほかのも連携したらより質上がる部分を連携させていくようにする」・純関数・DB/LLM なし）
// 2026-11-26 作業員A（統括役の頼み・台帳 p0）: linkage-map（連携の地図）と受け持ち表（conductor-duty・conductor-ownership）を土台に、
//   出す側ごとに 受け取る側（統括の入口・ブレインの判断・書き手・AIX の2通目・最後の確かめ）へ つながっている(on)／作ったが off／つないでいない(none)／未確認 を書く。
//   値打ち＝その中身がスタッフの手打ちの通（60日・2240通・AIX を除く・10字超）に入っていた割合（語の網の粗い数・11/26 昼）。AIX の2通目の欄は竹内さん本人の AIX の文（194通）を分母にした割合。
//   毎朝の1枚に 値打ちの高い切れ目 上位3つ（off か none の升だけ・未確認は持ち主が確かめるまで並べない）→ 上から1つずつ 既定 off でつなぐ → 試験 → on
export type Sink = "intake" | "brain" | "writer" | "aix2" | "final";
export const SINK_JA: Record<Sink, string> = { intake: "統括の入口", brain: "ブレインの判断", writer: "書き手", aix2: "AIX の2通目", final: "最後の確かめ" };
export type CellState = "on" | "off" | "none" | "unknown";
export type GapCell = { state: CellState; switch?: string; item?: number; note?: string };
export type GapSource = { id: string; name: string; owner: string; value: number | null; valueBase: string; cells: Partial<Record<Sink, GapCell>> };
const HAND = "手打ちの通 2240（60日）";
export const LINKAGE_GAP_SOURCES: readonly GapSource[] = [
  { id: "pickup_select", name: "物件検索・選定のブレイン（選んだ理由・合う点・合わない点）", owner: "作業員A", value: 12.4, valueBase: HAND,
    cells: { intake: { state: "none" }, brain: { state: "off", switch: "PICKUP_WHY_TO_BRAIN", item: 511, note: "本番で 0%・pending の 28% は PICKUP_WHY_PENDING_MATCH（#791）" }, writer: { state: "none", item: 790 }, aix2: { state: "on", note: "1件のオススメの2通目だけ" }, final: { state: "none" } } },
  { id: "aix_state_card", name: "AIX の札（束・内覧・見積・確認・候補の状態）", owner: "作業員A", value: 19.8, valueBase: HAND,
    cells: { intake: { state: "off", note: "指示書の extra に記録だけ（shadow）" }, brain: { state: "off", switch: "AIX_STATE_CARD", note: "本番は shadow・控えの行 aix_state_card" }, writer: { state: "none" }, aix2: { state: "unknown" }, final: { state: "none" } } },
  { id: "brain_decided", name: "ブレインの決め（目的と中期・こちら側の状態ほか10欄）", owner: "作業員A", value: 49.5, valueBase: "竹内さん本人の AIX の文 194（目的と中期 96）",
    cells: { writer: { state: "on", note: "決めた事の欄は書き手の注記に届く（欄ごとに違う）" }, aix2: { state: "none", item: 796, note: "2通目に配線のある欄 1/11・提案タブ 87e7dba6" } } },
  { id: "estimate_tool", name: "見積書ツール（金額・割引・内訳）", owner: "作業員L", value: 21.7, valueBase: HAND,
    // 2026-11-26 作業員L の確かめ（A が写した）
    cells: { intake: { state: "none" }, brain: { state: "on", switch: "BRAIN_ESTIMATE_RECORDS", item: 580, note: "物件・号室・初期費用・送った日。割引 BRAIN_ESTIMATE_DISCOUNT・見積の後の反応 BRAIN_ESTIMATE_REACTION は off" }, writer: { state: "on", switch: "COMPOSE_ASKS_FACTS", note: "初期費用と割引・新しい3件" }, aix2: { state: "unknown" }, final: { state: "on", note: "draft-fact-grounding が estimate_records の物件名を読む" } } },
  { id: "reaction_predict", name: "気持ちの読み・反応の予想", owner: "作業員L", value: 0.9, valueBase: HAND,
    cells: { brain: { state: "off", switch: "BRAIN_REACTION_PREDICT", item: 795, note: "作業員L が #795 で段ごとに数える" }, intake: { state: "unknown" }, writer: { state: "unknown" }, aix2: { state: "unknown" }, final: { state: "unknown" } } },
  { id: "property_check", name: "物件確認（募集中・終了・空き・交渉の結果）", owner: "作業員A", value: 2.5, valueBase: HAND,
    cells: { brain: { state: "on", note: "行動台帳・やる事の結果" }, writer: { state: "unknown" }, aix2: { state: "unknown" } } },
  { id: "viewing_calendar", name: "内覧の予定・カレンダー", owner: "作業員A", value: 19.8, valueBase: HAND,
    cells: { brain: { state: "on", note: "viewings・viewing_history" }, writer: { state: "unknown" }, aix2: { state: "unknown" } } },
  { id: "image_read", name: "画像の読み（送った・送られた物件の画像）", owner: "作業員A", value: 7.6, valueBase: HAND,
    cells: { brain: { state: "off", switch: "SIP_JUDGE", note: "ツールの外で送った 176番を拾う側" }, writer: { state: "unknown" } } },
  { id: "doc_read", name: "送った資料の読み", owner: "作業員A", value: 1.0, valueBase: HAND, cells: { brain: { state: "unknown" }, writer: { state: "unknown" } } },
  { id: "promise_ledger", name: "約束の台帳", owner: "作業員L", value: 21.8, valueBase: HAND, cells: { intake: { state: "on", switch: "CONDUCTOR_OVERDUE_PROMISES" }, brain: { state: "on", note: "期日超えの約束が統括の材料からブレインへ" }, writer: { state: "on", switch: "SITUATION_WRITER_NOTE", note: "開いている約束" }, aix2: { state: "off", switch: "SITUATION_WRITER_NOTE_AIX" }, final: { state: "unknown" } } },
  { id: "customer_memo", name: "顧客メモ", owner: "作業員A", value: null, valueBase: "語の網で数えられない", cells: { brain: { state: "unknown" } } },
  { id: "deal_data", name: "成約データ（太い道・申込の直前の一手）", owner: "作業員L", value: null, valueBase: "会社の中の数（文に出ない）", cells: { intake: { state: "off", switch: "CONDUCTOR_DEAL_FLOW_LINE", item: 728 }, brain: { state: "off", switch: "DEAL_FLOW_PRE_APPLY_LINE", item: 728 }, writer: { state: "none" }, aix2: { state: "none" }, final: { state: "none" } } },
  { id: "lessons", name: "統括の学び", owner: "作業員L", value: null, valueBase: "会社の中の数", cells: { intake: { state: "off", switch: "CONDUCTOR_LESSONS", note: "shadow＝読んで記録だけ" }, brain: { state: "none" }, writer: { state: "none" }, aix2: { state: "none" }, final: { state: "none" } } },
];
export type GapRank = { source: string; name: string; owner: string; sink: Sink; state: CellState; value: number; valueBase: string; switch?: string; item?: number; note?: string };
/** 値打ちの高い切れ目（off か none の升だけ・値打ちの無い出す側は外す・純関数） */
export function rankGaps(srcs: readonly GapSource[] = LINKAGE_GAP_SOURCES): GapRank[] {
  return srcs.flatMap((s) => (Object.entries(s.cells) as Array<[Sink, GapCell]>).filter(([, c]) => c.state === "off" || c.state === "none").filter(() => s.value != null)
    .map(([sink, c]) => ({ source: s.id, name: s.name, owner: s.owner, sink, state: c.state, value: s.value as number, valueBase: s.valueBase, switch: c.switch, item: c.item, note: c.note })))
    .sort((a, b) => b.value - a.value || (a.state === "off" ? -1 : 1));
}
/** 毎朝の1枚の行 */
export function gapTopLines(srcs: readonly GapSource[] = LINKAGE_GAP_SOURCES, k = 3): string[] {
  const r = rankGaps(srcs);
  const unk = srcs.reduce((a, s) => a + Object.values(s.cells).filter((c) => c?.state === "unknown").length, 0);
  return [`- 連携の切れ目（値打ちの高い順・上位${k}・作業員A の一覧 linkage-gap-matrix）: 切れ目 ${r.length}・未確認の升 ${unk}`,
    ...r.slice(0, k).map((g, i) => `  ${i + 1}. ${g.name} → ${SINK_JA[g.sink]}（${g.state === "off" ? `作ったが off${g.switch ? `・${g.switch}` : ""}` : "つないでいない"}・値打ち ${g.value}%＝${g.valueBase}${g.item ? `・#${g.item}` : ""}・${g.owner}）`)];
}
