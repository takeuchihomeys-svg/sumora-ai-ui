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
/** ③ 締め → 役目 */
export const CLOSING_TO_ROLE: Record<string, SentenceRole | null> = { nanitozo: "close", receipt: "close", kigaru: "close", viewing_cta: "viewing", apply_cta: "apply", none: null };
/** ③ 次 → 誘導先（compose-sentence-plan の LEAD_TOS） */
export const NEXT_TO_LEAD: Record<string, string> = { reply: "keep", viewing: "viewing", apply: "apply", send_property: "ask_send", wait_check: "none", answer_only: "answer_only", none: "none" };

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

// ─── 「この通の役目」の4語彙の対応表（1か所・2026-11-12 作業員10・統括役 作業員24 の洗い出し #2） ─────────────
//   4語彙: ① conductor-focus FOCUS_KINDS 7（夜の札付けの重点）② reply-compose-conductor MessageFocusKey 7（この通の重点）
//          ③ compose-blueprint ComposePurpose 6（趣旨）④ takeuchi-anatomy-roles SentenceRole 13（文の役目＝正）
//   一意に決まらなかった所（ask→close/propose・close→viewing/apply・promise→promise/keep・support と ease）は、
//   誘導先（next-move-types の NEXT_DEST＝ブレインの出力値）で行を選ぶ。派生（PURPOSE_TO_ROLE 等）はこの表から引くだけ。
import type { Focus } from "./conductor-focus";
import type { MessageFocusKey } from "./reply-compose-conductor";
import type { ComposePurpose } from "./compose-blueprint";
import type { NextDest } from "./next-move-types";

export type ComposeAimId =
  | "answer" | "promise_make" | "promise_keep" | "ease" | "support" | "close_viewing" | "close_apply"
  | "propose_send" | "hearing" | "ask_send" | "estimate" | "relation_ack" | "relation_keep";
export type ComposeAimRow = {
  id: ComposeAimId; ja: string;
  focus: Focus; messageFocus: MessageFocusKey; purpose: ComposePurpose;
  /** 主の文の役目（先頭が主） */
  roles: readonly SentenceRole[];
  /** 誘導先（NEXT_DEST）。この値で同じ語の行を選び分ける */
  dest: readonly NextDest[];
  /** 誘導先が無い時にこの語彙の既定の行にする（同じ語が複数の行にある時だけ） */
  primaryFor?: ReadonlyArray<"focus" | "messageFocus" | "purpose">;
};
export const COMPOSE_AIM_TABLE: readonly ComposeAimRow[] = [
  { id: "answer", ja: "聞かれた事に答える", focus: "answer", messageFocus: "answer", purpose: "inform", roles: ["answer"], dest: ["answer_only", "none"] },
  { id: "promise_make", ja: "確かめる約束をする", focus: "promise_make", messageFocus: "promise", purpose: "promise", roles: ["promise"], dest: ["wait_check"] },
  { id: "promise_keep", ja: "約束を果たす（結果を伝える）", focus: "promise_keep", messageFocus: "answer", purpose: "inform", roles: ["answer"], dest: ["wait_check", "answer_only"] },
  { id: "ease", ja: "不安を消す（奥の心配に答える）", focus: "ease", messageFocus: "ease", purpose: "support", roles: ["worry", "trust"], dest: ["none", "answer_only"] },
  { id: "support", ja: "支える（サポートの姿勢）", focus: "ease", messageFocus: "ease", purpose: "support", roles: ["trust"], dest: ["door", "keep_send"], primaryFor: ["purpose"] },
  { id: "close_viewing", ja: "決めに行く（内覧）", focus: "close", messageFocus: "close", purpose: "appeal", roles: ["viewing"], dest: ["viewing"] },
  { id: "close_apply", ja: "決めに行く（申込・抑える）", focus: "close", messageFocus: "close", purpose: "appeal", roles: ["apply", "barrier"], dest: ["apply"] },
  { id: "propose_send", ja: "物件を出す・探す約束", focus: "propose", messageFocus: "propose", purpose: "promise", roles: ["keep"], dest: ["keep_send"] },
  { id: "hearing", ja: "条件を聞く", focus: "propose", messageFocus: "propose", purpose: "ask", roles: ["ask_send"], dest: ["ask_condition"] },
  { id: "ask_send", ja: "物件・都合を送ってもらう", focus: "propose", messageFocus: "propose", purpose: "ask", roles: ["ask_send"], dest: ["ask_send"] },
  { id: "estimate", ja: "見積へ", focus: "propose", messageFocus: "propose", purpose: "inform", roles: ["estimate"], dest: ["estimate"] },
  { id: "relation_ack", ja: "受けて締める", focus: "relation", messageFocus: "relation_ack", purpose: "ack", roles: ["uke"], dest: ["none", "door"] },
  { id: "relation_keep", ja: "受けて関係を続ける", focus: "relation", messageFocus: "relation_keep", purpose: "ack", roles: ["keep", "uke"], dest: ["keep_send", "door"] },
];
/** どの語彙の値からでも行を選ぶ。候補が複数なら誘導先（NEXT_DEST）で選び、それでも決まらなければ表の先の行 */
export function aimOf(v: { focus?: Focus | null; messageFocus?: MessageFocusKey | null; purpose?: ComposePurpose | null; role?: SentenceRole | null }, dest: NextDest | null = null): ComposeAimRow | null {
  const c = COMPOSE_AIM_TABLE.filter((r) =>
    (v.focus == null || r.focus === v.focus) && (v.messageFocus == null || r.messageFocus === v.messageFocus) &&
    (v.purpose == null || r.purpose === v.purpose) && (v.role == null || r.roles[0] === v.role));
  if (!c.length) return null;
  return (dest ? c.find((r) => r.dest.includes(dest)) : null) ?? c[0];
}
const derive = <K extends string>(name: "focus" | "messageFocus" | "purpose", key: (r: ComposeAimRow) => K): Record<K, SentenceRole> => {
  const out = {} as Record<K, SentenceRole>;
  const rows = [...COMPOSE_AIM_TABLE.filter((r) => r.primaryFor?.includes(name)), ...COMPOSE_AIM_TABLE];
  for (const r of rows) { const k = key(r); if (!(k in out)) out[k] = r.roles[0]; }
  return out;
};
/** ③ 趣旨 → 主の役目（表から引くだけ・誘導先が無い時は表の先の行） */
export const PURPOSE_TO_ROLE: Record<ComposePurpose, SentenceRole> = derive("purpose", (r) => r.purpose);
/** ② この通の重点（MessageFocusKey）→ 主の役目（表から） */
export const FOCUS_TO_ROLE: Record<MessageFocusKey, SentenceRole> = derive("messageFocus", (r) => r.messageFocus);
/** ① 夜の札付けの重点（FOCUS_KINDS）→ 主の役目（表から） */
export const NIGHT_FOCUS_TO_ROLE: Record<Focus, SentenceRole> = derive("focus", (r) => r.focus);
/** 夜の重点 → この通の重点（表から・1対1でない所は誘導先で選ぶ） */
export function messageFocusOfFocus(f: Focus, dest: NextDest | null = null): MessageFocusKey | null {
  return aimOf({ focus: f }, dest)?.messageFocus ?? null;
}
