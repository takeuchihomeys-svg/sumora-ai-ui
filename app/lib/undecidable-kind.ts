// app/lib/undecidable-kind.ts — ブレインが判断できない番の種類（a〜e）の候補（決まった語の網・純関数）
//
// 2026-11-03 竹内さん（KB P1「ブレインが判断できない所を細かく分けて対策する」）:
//   「判断できない部分は何か。細かく細分化して改善していく。例えば内覧に行った物件はメモに控えておくなど。AIX での部分なら AIX で送るなど」
//   a LINE の外で起きた事が記録に無い（電話の結果・内覧に行った物件・現地で話した事）
//   b 結果待ち（管理会社の返事）
//   c スタッフしか知らない事（スタッフの文・AIX の入力にしか無い事実）
//   d お客様の意図があいまい（2通りに読める・主語が無い・短い）
//   e 会社の内部の決定（交渉・割引・特例）
//   ここは候補の網だけ（1つの番に複数あり得る）。迷う番は安い時間に DeepSeek で読む。対策の案は scripts/audit-undecidable-kinds.ts の表に。
export type UndecidableKind = "a" | "b" | "c" | "d" | "e";
export const UNDECIDABLE_JA: Record<UndecidableKind, string> = {
  a: "LINE の外で起きた事が記録に無い", b: "結果待ち（管理会社の返事）", c: "スタッフしか知らない事", d: "お客様の意図があいまい", e: "会社の内部の決定（交渉・割引）",
};
export const UNDECIDABLE_FIX: Record<UndecidableKind, string> = {
  a: "控えを残す入口（内覧に行った物件・電話のメモをお客様のメモか台帳に）",
  b: "確認の約束（結果が来たら AIX）",
  c: "AIX の番（作業員1の逆向きの相談で AIX の統括に聞く）",
  d: "お客様にヒアリング",
  e: "AIX の番（交渉・割引はスタッフが入力して送る）",
};

const A_OUT = /(お電話|電話で|お電話にて|通話|先ほどの電話|内覧(?:の際|時|に行った|させて頂いた|当日)|ご内覧(?:頂き|ありがとう)|現地で|お会いした|ご来店|来店|直接お話)/;
const B_WAIT = /(管理会社(?:に|へ)?(?:確認|問い合わせ|聞いて)|確認(?:中|して(?:おります|います))|回答待ち|返事待ち|折り返し|確認(?:が|の)取れ次第|確認出来次第|確認でき次第)/;
const E_DECIDE = /(交渉|値下げ|値引き|割引|お値引|特別に|特例|オーナー(?:様)?(?:に|へ)?(?:相談|確認)|フリーレント(?:交渉|つけ))/;
const AMBIG_SHORT = /^(?:はい|了解|わかりました|ok|ｏｋ|大丈夫です|どうしよう|うーん|んー|検討します|考えます)[!！。.〜ー]*$/i;
const NO_SUBJECT = /^(?:ここ|これ|それ|あれ|そこ)(?:は|って|も)?/;

export function undecidableKinds(o: {
  customerText: string; staffText?: string | null; aixInput?: string | null; draft?: string | null; hasRecordOfFact?: boolean;
}): UndecidableKind[] {
  const cust = (o.customerText ?? "").trim(), staff = (o.staffText ?? "").trim(), aix = (o.aixInput ?? "").trim();
  const out = new Set<UndecidableKind>();
  if ((A_OUT.test(cust) || A_OUT.test(staff)) && !o.hasRecordOfFact) out.add("a");
  if (B_WAIT.test(staff) || B_WAIT.test(o.draft ?? "")) out.add("b");
  // c: スタッフの文に数字・日時・金額があり、下書きに無い（スタッフしか知らない事実を書いた）
  const facts = (s: string) => (s.match(/\d{1,2}[:：]\d{2}|\d{1,2}\/\d{1,2}|\d{1,3}(?:,\d{3})+円|\d+(?:\.\d+)?万|空いて(?:おり|い)ます|募集(?:中|終了)|申込(?:が)?入っ/g) ?? []);
  const staffFacts = facts(staff), draftFacts = new Set(facts(o.draft ?? ""));
  if (aix || staffFacts.some((f) => !draftFacts.has(f))) out.add("c");
  if (AMBIG_SHORT.test(cust) || (NO_SUBJECT.test(cust) && cust.length <= 20)) out.add("d");
  if (E_DECIDE.test(cust) || E_DECIDE.test(staff)) out.add("e");
  return [...out].sort();
}
