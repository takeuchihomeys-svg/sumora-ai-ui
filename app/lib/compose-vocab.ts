// app/lib/compose-vocab.ts — 文の統括の語彙を1つ（文の役目13種）にまとめる（純関数・既定 off）
//
// 2026-11-12 作業員10（統括役・作業員18 の洗い出し 台帳 writer:compose-vocab-duplicate）。
//   本番で書き手に効いている「文の組み立て」の語彙を数えた（コードの既定と本番の env・11/12 朝）:
//     ① writing-blueprint（WRITING_BLUEPRINT 既定 on）＝ 段9つ（名前・挨拶・お礼・受け・答え・約束・誘い・支える一言・締め）と場面ごとの並び・要る段・書かない段
//     ② compose-sentence-plan（COMPOSE_SENTENCE_PLAN 既定 on・11/12〜）＝ 文の役目13種（takeuchi-anatomy-roles）・主と従・1文ずつ
//     ③ compose-blueprint（BRAIN_COMPOSE_BLUEPRINT 既定 off・本番の env にも無い）＝ 趣旨6・締め6・次7 → 本番の書き手には届いていない。
//        使っているのは夜の札付け（conductor-focus.purposeOfText・takeuchi-anatomy の purpose）と、既定 off の AIX の設計図（aix-first・second）だけ
//     ④ reply-compose-conductor（COMPOSE_CONDUCTOR 既定 off）＝ 重点7つ → 本番では届いていない
//   ＝本番の書き手の注記には ①の「この順で段を組む」と ②の「主を先に・従は後に」が両方並び、場面の「書かない段: 誘い」と設計図の誘導の行がぶつかりうる。
//   まとめ方（COMPOSE_VOCAB_UNIFIED=on・既定 off・設計図の注記が出る番だけ）:
//     a 語彙の正は文の役目13種。段・趣旨・締め・次は対応表で役目に写す（下の表・夜の札付けもこの表で写せる）
//     b 場面の決まり（①の要る段・書かない段）は設計図の行に効かせる: 書かない段に当たる従の行は外す（主は外さない）。要る段で設計図に無い役目は記録だけ
//       （竹内さんの24番で、要る段から足す役目 4番 4/4 が竹内さんの文に無かった: q022・q025 検討中の「支える一言」・q206・q208 の「答え」＝書き手には渡さない）
//     c ①の注記からは並びの行と要る段・書かない段の行を外す（設計図と二重）。受けの言葉は1回・ご査収・長さ・場面の一言は残す
//   ③④は本番に届いていないので、まとめた後は「夜の札付けの語彙」として対応表だけで写す（コードを消すのは統括役の判断の後）
// テスト: npx tsx app/lib/__tests__/compose-vocab.test.ts
import type { SentenceRole } from "./takeuchi-anatomy-roles";
import type { BlueprintPart } from "./writing-blueprint";
import { resolveBlueprint } from "./writing-blueprint";
import type { ReplyScene } from "./reply-scene";
import type { SentencePlan, PlanRow } from "./compose-sentence-plan";

type Env = Record<string, string | undefined>;
export function composeVocabUnifiedOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_VOCAB_UNIFIED ?? "").trim().toLowerCase() === "on";
}

/** ① 段 → 役目（誘いは何への誘いかで分かれる・約束は管理会社への確かめ promise と探す約束 keep の両方） */
export const PART_TO_ROLES: Record<BlueprintPart, readonly SentenceRole[]> = {
  name: ["greet"], greeting: ["greet"], thanks: ["uke"], ack: ["uke"], answer: ["answer"],
  promise: ["promise", "keep"], invite: ["viewing", "apply", "estimate", "ask_send"], support: ["trust"], closing: ["close"],
};
/** ③ 趣旨（compose-blueprint の purpose）→ 主の役目 */
export const PURPOSE_TO_ROLE: Record<string, SentenceRole> = { appeal: "viewing", support: "trust", promise: "promise", inform: "answer", ask: "ask_send", ack: "uke" };
/** ③ 締め → 役目 */
export const CLOSING_TO_ROLE: Record<string, SentenceRole | null> = { nanitozo: "close", receipt: "close", kigaru: "close", viewing_cta: "viewing", apply_cta: "apply", none: null };
/** ③ 次 → 誘導先（compose-sentence-plan の LEAD_TOS） */
export const NEXT_TO_LEAD: Record<string, string> = { reply: "keep", viewing: "viewing", apply: "apply", send_property: "ask_send", wait_check: "none", answer_only: "answer_only", none: "none" };
/** ④ 重点（reply-compose-conductor の MessageFocusKey）→ 主の役目 */
export const FOCUS_TO_ROLE: Record<string, SentenceRole> = { answer: "answer", promise: "promise", ease: "worry", close: "viewing", propose: "keep", relation_ack: "uke", relation_keep: "keep" };

const ROLE_JA_SHORT: Partial<Record<SentenceRole, string>> = { trust: "信頼を得る（支える一言・姿勢だけ）", answer: "問いへの答え", promise: "確かめる約束", keep: "新着の約束・関係をつなぐ", uke: "受け" };

/** b 場面の決まりを設計図に効かせる（on の時だけ・主の行は外さない）。外した行と要る役目を返す */
export function applySceneConstraints(p: SentencePlan, scene: ReplyScene | string | null | undefined, env?: Env): SentencePlan & { removed: SentenceRole[]; requiredRoles: SentenceRole[] } {
  if (!composeVocabUnifiedOn(env) || !scene || !p.rows.some((r) => r.rank === "main")) return { ...p, removed: [], requiredRoles: [] };
  let bp: ReturnType<typeof resolveBlueprint>;
  try { bp = resolveBlueprint({ scene: scene as ReplyScene, routeBranch: null }); } catch { return { ...p, removed: [], requiredRoles: [] }; }
  const forbidden = new Set(bp.forbidden.flatMap((x) => PART_TO_ROLES[x] ?? []));
  const removed: SentenceRole[] = [];
  const rows: PlanRow[] = p.rows.filter((r) => { if (r.rank === "sub" && forbidden.has(r.role)) { removed.push(r.role); return false; } return true; });
  const requiredRoles = bp.required.filter((x) => !["name", "greeting", "thanks", "ack", "closing"].includes(x))
    .filter((x) => !(PART_TO_ROLES[x] ?? []).some((r) => rows.some((row) => row.role === r)))
    .map((x) => (PART_TO_ROLES[x] ?? [])[0]).filter((x): x is SentenceRole => !!x);
  return { ...p, rows, removed, requiredRoles };
}
/** 要る役目の1行（設計図の注記の後ろ）。無ければ空文字 */
export function requiredRolesLine(roles: readonly SentenceRole[]): string {
  return roles.length ? `- この場面で要る役目（設計図に無ければ1文だけ・材料に無い事実は書かない）: ${roles.map((r) => ROLE_JA_SHORT[r] ?? r).join("・")}` : "";
}
/** c ①の注記から設計図と二重の行（並び・要る段・書かない段）を外す（on で設計図の注記が出る番だけ呼ぶ） */
export function stripWritingBlueprintOrder(note: string): string {
  return String(note ?? "")
    .split("\n")
    .map((l) => l.replace(/】この順で段を組む（無い段は飛ばす）: [^\n]*$/, "】（文の並びと役目は「文の設計図（1文ずつ・文の統括）」に従う）"))
    .filter((l) => !/^- (?:要る段|書かない段): /.test(l))
    .join("\n");
}
