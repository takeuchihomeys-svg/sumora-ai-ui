// app/lib/final-check-brain-align.ts — 最終チェックの「直す・直さない」をブレインの判断にそろえる（純関数・2026-10-13）
//
// 竹内さん 2026-10-13「最終チェックの部分でも、指摘のアナウンスでブレインが正しいが、実際の文が修正されていないことが良くある。
//   これもブレイン判断になっていないのが原因なのでは」。設計知見 P0 9eb6aa9c「判断はすべてブレイン基準」・P1 0593a0aa・bbfb06d6（本質が最上位）・df9bdfac（引用の定義と直す段の条件のずれ）。
//
// 旧（final-check.ts runFinalCheckWithRevision）: 書き直しに渡すのは「引用（evidence）が下書きの本文にそのまま入っている指摘」だけ。
//   ・引用＝お客様の質問（MISSED_QUESTION の出力例どおり）→ 一度も書き直しに渡らない
//   ・引用に「…」の省略・「」の二重・複数の引用の並び（「A」「B」）→ 本文と1文字でも違えば渡らない
//   ・引用＝説明（「返信文に『今年中』への言及がない」）→ 渡らない
//   → 画面には「ブレインは〇〇と決めているのに…」の指摘が出るのに、本文は直らない（30日で 指摘が残った下書きの多くがこの道・audit-final-check-unfixed.ts）。
// 新: 直すかどうかを「ブレインの判断に沿うか」で決める。
//   ① ブレインの判断（本質 turn_contract）とぶつかる指摘 → 直さない（今まで通り issueContradictsContract）
//   ② 引用が本文にある（省略・括弧・並びを分けて断片で照らす）→ 直す
//   ③ 引用が本文に無くても、ブレインが「返信で答える／約束する」と決めた項目・ブレインが読んだお客様の質問を指す取りこぼしの指摘 → 直す（ブレインが裏付け）
//   ④ それ以外（引用が本文に無く、ブレインの裏付けも無い）→ 直さない（今まで通り＝作り話の指摘で書き直さない）
//   直さなかった指摘には「直さなかった理由」を付けて画面に出す（直せない時は理由を出す）。ブレインとぶつかる warning は画面の指摘から外し brain_overruled に残す。
// 戻す: FINAL_CHECK_BRAIN_ALIGN=off（旧の「引用が本文にそのまま」だけ・理由の注記なし・ぶつかる指摘も画面に出す）
import type { TurnContract } from "./turn-contract";

type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});
export function finalCheckBrainAlignEnabled(env?: Env): boolean {
  return (envOf(env).FINAL_CHECK_BRAIN_ALIGN ?? "").trim().toLowerCase() !== "off";
}

export type AlignIssue = { code: string; severity: string; message?: string; evidence?: string; suggestion?: string };

/** 照らす用の正規化（空白・絵文字・括弧・句読点・記号を外し NFKC） */
export function normForAnchor(s: string): string {
  return String(s ?? "").normalize("NFKC")
    .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "")
    .replace(/[\s「」『』""“”'’（）()［］\[\]【】、。，．,.!！?？・:：;；〜~ー\-—–…]/g, "");
}

/** 引用を「…」「」・／・改行・vs で断片に分ける（8字以上の断片だけ） */
function evidenceFragments(evidence: string): string[] {
  return String(evidence ?? "")
    .split(/…+|\.{3,}|[「」『』]|／|\/|\n|\bvs\b|＞|>|→/)
    // 「返信: 〜」「実際の返信：〜」「修正後ドラフト：〜」の見出しを外す（ad97cd40「顧客メッセージ: X / 返信: Y」）
    .map((f) => f.trim().replace(/^(?:実際の|修正後の?)?(?:返信文?|実返信|ドラフト|下書き|本文)\s*[:：]\s*/, ""))
    .filter((f) => !/^\s*(?:顧客メッセージ|お客様|スタッフ依頼|直近のスタッフ)[^:：]{0,6}[:：]/.test(f))
    .map(normForAnchor)
    .filter((f) => f.length >= 8);
}

/**
 * 引用が下書きの本文にあるか（省略・括弧の二重・複数の引用の並びに強い）。
 * 全体が本文にある、または8字以上の断片の1つでも本文にあれば本文の引用とみなす。
 */
export function evidenceAnchoredInDraft(evidence: string | undefined, draft: string): boolean {
  if (!evidence) return true; // 引用の無い指摘は旧と同じく通す（決定論の指摘など）
  const d = normForAnchor(draft);
  const e = normForAnchor(evidence);
  if (!e) return true;
  if (d.includes(e)) return true;
  return evidenceFragments(evidence).some((f) => d.includes(f));
}

function bigrams(s: string): Set<string> {
  const t = normForAnchor(s);
  return new Set(Array.from({ length: Math.max(t.length - 1, 0) }, (_, i) => t.slice(i, i + 2)));
}
/** 2つの文の近さ（2文字の重なり・Dice） */
export function textOverlap(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return (2 * hit) / (A.size + B.size);
}
/** 項目の2文字の何割が指摘の文に入っているか（指摘の文は説明で長いので Dice でなく項目側の割合で見る） */
export function itemCoverage(issueText: string, item: string): number {
  const I = bigrams(item), T = bigrams(issueText);
  if (!I.size) return 0;
  let hit = 0;
  for (const x of I) if (T.has(x)) hit++;
  return hit / I.size;
}
/** 指摘の文（引用・説明）がその項目を指しているか（項目の頭8字が入る or 項目の2文字の 6割以上が入る） */
function refersTo(issueText: string, item: string): boolean {
  const it = normForAnchor(item);
  if (it.length < 4) return false;
  const tx = normForAnchor(issueText);
  if (tx.includes(it.slice(0, Math.min(8, it.length)))) return true;
  return itemCoverage(issueText, item) >= 0.6;
}

/** 取りこぼし・答え忘れの型（引用がお客様の文になる指摘） */
/** 指摘がブレインの判断を根拠に挙げている（「Brain判定」「Brain指示」「Brain の方針」「ブレインが」等） */
const BRAIN_CITED_RE = /Brain\s*(?:判定|指示|の?方針|の?判断|の?必須|が)|ブレイン(?:の|が)/;
/** ブレインを挙げても「ブレインの対象外・問題視しない・整合している」と言う指摘は裏付けにしない（1095eb88「Brain判断の復唱対象外のため、問題視しない選択も可」） */
const BRAIN_DISCLAIM_RE = /対象外|問題視しない|問題ない|整合して|沿って(?:い)?る|軽微/;
const OMISSION_CODES =/^(?:MISSED_QUESTION|CONDITION_ADD_MISROUTED|STAFF_REQUEST_OMITTED|CONCERN_UNADDRESSED)$/;

/**
 * ブレインがこの指摘を裏付けるか（引用が本文に無くても直してよいか）。
 * - 取りこぼしの型で、指している項目をブレインが「返信で答える／約束する」と決めている（本質）→ 裏付け
 * - 本質が無い時は、ブレインが読んだお客様の質問（customer_questions）を指していれば裏付け
 * - ブレインが「AIX の番／触れない」と決めた項目を指す・閉じる番 → 裏付けなし（そもそもぶつかる）
 */
export function brainBacksIssue(issue: AlignIssue, contract: TurnContract | null | undefined, customerQuestions?: ReadonlyArray<string> | null): boolean {
  const text = `${issue.evidence ?? ""} ${issue.message ?? ""}`;
  // 検査がブレインの判断（検査に渡した【Brain判定済み】）を根拠に「ブレインが決めた中身が本文に無い」と言う指摘
  //   （例 615499ba「Brain指示には『11月末入居のご条件に合うお部屋を』と明記されているが、実返信に入居時期の言及がない」）。
  //   ＝竹内さんの言う「指摘のアナウンスでブレインが正しい」の型。作り話・名前の指摘（引用が本文に無いと書き直しの根拠が無い）は除く。閉じる番は除く（足す指摘になる）
  if (BRAIN_CITED_RE.test(text) && !BRAIN_DISCLAIM_RE.test(text) && !/^(?:FABRICATED_|NAME_|BANNED_WORD|NG_PROPERTY)/.test(issue.code) && !(contract?.closeOnly)) return true;
  if (!OMISSION_CODES.test(issue.code)) return false;
  if (contract && contract.source === "brain") {
    if (contract.closeOnly) return false;
    const hit = contract.asks.find((a) => refersTo(text, a.quote));
    if (hit) return hit.route === "reply" || hit.route === "promise";
    // 本質の項目に無い質問は、ブレインが読んだ質問（customer_questions）にあれば裏付け
  }
  return (customerQuestions ?? []).some((q) => String(q ?? "").trim() && !/^\(未対応\)/.test(String(q)) && refersTo(text, String(q)));
}

export type HoldReason = "contradicts_brain" | "not_revisable" | "unanchored";
export const HOLD_REASON_JA: Record<HoldReason, string> = {
  contradicts_brain: "ブレインの判断（この番の本質）と逆の指摘のため直していません",
  not_revisable: "表示だけの指摘（自動では直しません）",
  unanchored: "指摘の引用が下書きに無く、ブレインの判断の裏付けも無いため直していません",
};

/**
 * 書き直しに渡す指摘を選ぶ（warning の道・block の道の両方が同じ関数で選ぶ）。
 * isRevisable・contradicts は呼び出し元の関数を渡す（final-check.ts の決まりをそのまま使う）。
 */
export function selectRevisionIssues<T extends AlignIssue>(
  issues: readonly T[],
  draft: string,
  opts: {
    contract: TurnContract | null | undefined;
    customerQuestions?: ReadonlyArray<string> | null;
    isRevisable: (i: T) => boolean;
    contradicts: (i: T) => boolean;
    /** 旧の判定（引用が本文にそのまま）。FINAL_CHECK_BRAIN_ALIGN=off の時に使う */
    legacyAnchored: (i: T) => boolean;
    env?: Env;
  },
): { pass: T[]; held: Array<{ issue: T; reason: HoldReason }> } {
  const on = finalCheckBrainAlignEnabled(opts.env);
  const pass: T[] = [];
  const held: Array<{ issue: T; reason: HoldReason }> = [];
  for (const i of issues) {
    if (i.code === "UNCHECKED_AUTO_SEND" || !opts.isRevisable(i)) { held.push({ issue: i, reason: "not_revisable" }); continue; }
    if (opts.contradicts(i)) { held.push({ issue: i, reason: "contradicts_brain" }); continue; }
    const anchored = on
      ? evidenceAnchoredInDraft(i.evidence, draft) || brainBacksIssue(i, opts.contract, opts.customerQuestions)
      : opts.legacyAnchored(i);
    if (anchored) pass.push(i); else held.push({ issue: i, reason: "unanchored" });
  }
  return { pass, held };
}

/**
 * ブレインの本質に照らした下書きの確かめ（最終チェックの決定論の段に入れる・ブレインの判断を物差しにする唯一の検査）。
 *   今は1つだけ: 本質に確認・作成の約束が無いのに「確認させて頂きます／確認出来次第ご連絡」を書いた（H4・生成の確認の関門 applyContractToConfirm と同じ決まり）。
 *   旧は generate-reply の記録（turn-contract:audit）だけで、最終チェックの指摘にも書き直しにも入っていなかった＝「確認の対象が無い」等の別の物差しの指摘が
 *   ブレインと逆の直し方（確認の対象を足せ）を言い、ぶつかるので直らない（10/10 fecda03f: 本質は「小型犬2匹可の物件をピックアップしてお送り」・下書き「確認出来次第ご連絡させて頂きます」）。
 *   直し方の案は本質の約束の中身（answer）。本質がブレインでない・確認の約束が本質にある時は何もしない。戻す FINAL_CHECK_BRAIN_ALIGN=off
 */
export function contractConfirmMiss(draft: string, contract: TurnContract | null | undefined, canConfirm: (a: TurnContract["asks"][number]) => boolean, env?: Env): { sentence: string; suggestion: string } | null {
  if (!finalCheckBrainAlignEnabled(env) || !contract || contract.source !== "brain") return null;
  if (contract.asks.some(canConfirm)) return null;
  const t = String(draft ?? "").normalize("NFKC");
  // 「ご確認の上」「ご確認ください」（お客様の行い）は数えない
  const m = t.match(/[^\n。！!]*(?<!ご)確認(?:させて|出来次第|でき次第|しご連絡|の上)[^\n。！!]*[。！!]*/);
  if (!m) return null;
  const promise = contract.asks.find((a) => a.route === "promise" && a.answer)?.answer ?? null;
  return {
    sentence: m[0].trim().slice(0, 80),
    suggestion: contract.closeOnly
      ? "返事の要らない番（ブレインの判断）: 確認の約束の文を消し、受けの一言＋締めだけにする"
      : promise ? `ブレインが決めた約束「${promise}」の一文に置き換える（確認の約束にしない）` : "確認の約束の文を消す（ブレインの本質に確認・作成の約束が無い）",
  };
}

/** 書き直しを採らなかった理由（final-check の revision_dropped）を画面の言葉に */
export const DROP_REASON_JA: Record<string, string> = {
  budget: "時間が足りず書き直しませんでした",
  no_passable: "書き直しに渡せる指摘がありませんでした",
  revision_failed: "書き直しが失敗しました",
  banned_word: "書き直しが禁止の言葉を入れたため元の文のままです",
  await_block: "書き直しが場面に合わない待ちの文を入れたため元の文のままです",
  confirm_promise: "書き直しがブレインに無い確認の約束を入れたため元の文のままです",
  recheck_unverified: "書き直しの再検査が終わらず元の文のままです",
  recheck_block: "書き直しで別の止める指摘が出たため元の文のままです",
  warn_worse: "書き直しで指摘が増えたため元の文のままです",
  new_warn_type: "書き直しで別の種類の指摘が出たため元の文のままです",
  evidence_kept: "書き直しでも該当の文が消えませんでした",
  no_improve: "書き直しても止める指摘が減りませんでした",
};

/**
 * 最後に残った指摘に「直さなかった理由」を付ける（画面はこれを出す）。
 * - held（選ばれなかった指摘）は code＋引用で突き合わせて理由を付ける
 * - 選ばれたのに残った指摘は revision_dropped の理由（無ければ「書き直し後も残りました」）
 * - ブレインとぶつかる warning は画面の指摘から外す（overruled に移す）。block は安全の線なので外さない
 */
export function annotateUnfixed<T extends AlignIssue & { unfixed_reason?: string }>(
  finalIssues: readonly T[],
  held: ReadonlyArray<{ issue: AlignIssue; reason: HoldReason }>,
  revisionDropped: string | null | undefined,
  revised: boolean,
  env?: Env,
): { shown: T[]; overruled: T[] } {
  if (!finalCheckBrainAlignEnabled(env)) return { shown: [...finalIssues], overruled: [] };
  const key = (i: AlignIssue) => `${i.code}|${normForAnchor(i.evidence ?? "").slice(0, 40)}`;
  const heldBy = new Map<string, HoldReason>();
  for (const h of held) heldBy.set(key(h.issue), h.reason);
  const heldByCode = new Map<string, HoldReason>();
  for (const h of held) if (!heldByCode.has(h.issue.code)) heldByCode.set(h.issue.code, h.reason);
  const shown: T[] = [], overruled: T[] = [];
  for (const i of finalIssues) {
    if (i.severity === "info") { shown.push(i); continue; }
    const r = heldBy.get(key(i)) ?? (revised ? undefined : heldByCode.get(i.code));
    if (r === "contradicts_brain" && i.severity !== "block") { overruled.push({ ...i, unfixed_reason: HOLD_REASON_JA[r] }); continue; }
    if (r === "not_revisable") { shown.push(i); continue; }
    const why = r ? HOLD_REASON_JA[r] : revisionDropped ? (DROP_REASON_JA[revisionDropped] ?? `書き直しを採りませんでした（${revisionDropped}）`) : revised ? "書き直した後も残りました（手で直してください）" : null;
    shown.push(why ? { ...i, unfixed_reason: why } : i);
  }
  return { shown, overruled };
}
