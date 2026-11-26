// app/lib/linkage-gap-reply-rows.ts — 連携の切れ目の一覧の「返信の土台」の行（作業員L の持ち分・linkage-gap-matrix が import して連ねる）
// 2026-11-26 作業員A が空の配列で置いた（L が埋める・ぶつからないよう別ファイル）。形は linkage-gap-matrix の GapSource と同じ
// 2026-11-26 作業員L（竹内さん 11/26「AIX だけではなくて、返信の土台の部分やブレインの部分で連携させていく」・統括役の割り振り・#466 の持ち分）:
//   升の状態はコードの既定（スイッチの書き方）と配線を読んで決めた。値打ち＝竹内さん本人の手打ちの通（60日・800通）に、その中身の言い方が入っていた割合（語の網の粗い数）。
//   語の網の無い土台（手本・知識・文の決まり・書き方の型）は value=null（値打ちは測り方を決めてから）
import type { GapSource } from "./linkage-gap-matrix";

const TK = "竹内さん本人の手打ちの通 800（60日）";
export const LINKAGE_GAP_REPLY_ROWS: readonly GapSource[] = [
  { id: "reply_exemplar", name: "竹内さんの書き方の手本の検索（takeuchi_exemplars）", owner: "作業員L", value: null, valueBase: "語の網が無い（手本の型で測る台本を作ってから）",
    cells: { intake: { state: "none" }, brain: { state: "none" }, compose: { state: "on", switch: "TAKEUCHI_EXEMPLAR", note: "文の設計図（COMPOSE_SENTENCE_PLAN 既定 on）の時だけ手本を引く" }, writer: { state: "on", switch: "TAKEUCHI_EXEMPLAR" }, aix2: { state: "unknown" }, final: { state: "none" } } },
  { id: "reply_knowledge", name: "返信の知識（ai_reply_knowledge）", owner: "作業員L", value: null, valueBase: "語の網が無い（知識の id ごとの使われ方は KNOWLEDGE_USAGE_TABLE）",
    cells: { intake: { state: "none" }, brain: { state: "unknown", note: "ブレインは設計知見（design_knowledge）を別に引く" }, compose: { state: "unknown" }, writer: { state: "on", note: "書き手の RAG" }, aix2: { state: "off", switch: "AIX_SECOND_KNOWLEDGE" }, final: { state: "unknown" } } },
  { id: "reply_rules", name: "文の決まり（書き手の決まり・最後の確かめの決まり）", owner: "作業員L", value: null, valueBase: "決まりは守り率で測る（台本はまだ）",
    cells: { intake: { state: "none" }, brain: { state: "none" }, compose: { state: "unknown" }, writer: { state: "on" }, aix2: { state: "unknown" }, final: { state: "on", note: "final_check の rule_check" } } },
  { id: "reply_form_slots", name: "書き方の型（決まった欄の型・言い回しの目録）", owner: "作業員L", value: null, valueBase: "語の網が無い",
    cells: { compose: { state: "off", switch: "COMPOSE_FORM_SLOTS", item: 112, note: "11/14 に悪化0（比べた 3問）・#786 の確かめ直しの 9つに入れた" }, writer: { state: "off", switch: "COMPOSE_PHRASE_CATALOG", item: 195 } } },
  { id: "reply_tsunagi", name: "つなぎ（前の話と今の話をつなぐ一文）", owner: "作業員L", value: 4.6, valueBase: `${TK}に「併せて・また、・ちなみに 等」が入っていた割合`,
    cells: { intake: { state: "none" }, brain: { state: "unknown" }, compose: { state: "unknown" }, writer: { state: "off", switch: "TSUNAGI_ONE_PLACE", item: 235, note: "比べた問題が少ない（両方で解いた 3/4問）" }, aix2: { state: "unknown" } } },
  { id: "reply_closing", name: "締め（場面で変わる締め: ご検討の程・お手隙の際・お気軽に・ご都合よろしい日・いかがでしょうか 等）", owner: "作業員L", value: 31.9, valueBase: `${TK}に場面で変わる締めが入っていた割合（決まり文句「何卒よろしくお願い」21.4% は書き手の決まりで既に出るので外した・作業員A と決め）`,
    cells: { intake: { state: "none" }, brain: { state: "none" }, compose: { state: "unknown", note: "締めの一文の型は文の設計図の役目（どの番でどの締めか＝連鎖の型で数える）" }, writer: { state: "on", note: "書き手の決まりに締めの形" }, aix2: { state: "unknown" }, combo: { state: "none", note: "本当の切れ目＝どの番でどの締めか（気持ち＋約束＋手本の型 → 締めの一文）。chain-patterns-reply の型で数える（11/27）" } } },
  { id: "reply_trust", name: "信頼の一文（お待たせ・確認しましたところ・ご安心 等）", owner: "作業員L", value: 3.0, valueBase: `${TK}に信頼の一文の言い方が入っていた割合`,
    cells: { intake: { state: "none" }, brain: { state: "unknown", note: "trust-b4b5 の数えはある・ブレインの材料には未確認" }, compose: { state: "unknown" }, writer: { state: "unknown" }, aix2: { state: "unknown" } } },
  { id: "reply_timeline", name: "時系列の帳面（お客様の時の言葉・内覧・約束と連絡の日）", owner: "作業員L", value: 11.6, valueBase: `${TK}に日付・明日・今週 等の時の言葉が入っていた割合`,
    cells: { intake: { state: "none" }, brain: { state: "on", switch: "BRAIN_SITUATION_TIMELINE" }, compose: { state: "unknown" }, writer: { state: "on", switch: "SITUATION_WRITER_NOTE", note: "時の言葉と内覧は届く・約束と連絡の日は SITUATION_WRITER_TIMELINE_PROMISES（off）" }, aix2: { state: "off", switch: "SITUATION_WRITER_NOTE_AIX" }, final: { state: "unknown" } } },
];
