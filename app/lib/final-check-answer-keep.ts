// final-check-answer-keep.ts — 最終チェックの書き直しがブレインの答え・約束を消さないための2つの関所（純関数）
//
// 2026-11-12 作業員15（竹内さん「ファイナルチェックの部分ボトルネックになっていないかも確認」・KB 5cf2d736・0be2d9f5・P0 9eb6aa9c）。
// 実物（ai_reply_examples の tpo_debug.postprocess.exitEdits・10/29〜11/11・最終チェックの書き直し 35件を目で読んだ）:
//
// ① 語の網（PHASE_PROHIBITIONS の TIMING_VOCAB_MISMATCH＝審査・保証会社／契約の手続き／鍵の語を「段階より早い」と block）が、
//    お客様が今聞いた「いつから住めるか・契約してからどのくらいか」への答えの文を書き直しに渡し、答えが縮む・確認の約束に置き換わっていた。
//    例（伏せ）: 「YUMAさん契約してからどのくらいで住めますか」→ 下書き「お申込み後は保証会社の審査（3日〜10日程）、ご契約手続きを経て…最短2週間程」
//      → 書き直し「ご入居日はお部屋によって変わりますので、確認出来次第お伝えさせて頂きます」。スタッフの実送信は審査1〜2週間・契約・2〜3週間の流れの説明（＝下書きが正しかった）。
//    ブレインが返信で答える（route=reply）と決めた番でも同じ。決まり（feedback_procedure_question_reply）＝審査・入居までの期間と流れの質問は返信で説明。
//    → この網は「段階より早い言及」を拾う候補の網で、作り話を止める安全の線ではない（KB 0be2d9f5）。お客様の今の質問・ブレインの答え／約束の文なら書き直しに渡さない。
//      本文はそのまま（block は画面と自動送信の関所に残る＝スタッフが見る）。見積の ban（ESTIMATE_BAN）は対象外（金額・作成宣言は別の線）。
//
// ② 書き直しの LLM が、元の下書きに無かった会社の事実に反する断定を足していた（「初期費用のお支払い方法はお振込での一括のみでの対応となります」
//    ＝カード払い可・3.24% の会社の事実と逆。スタッフはカード可で送った）。再検査の V16 は「お客様がその事実を聞いた」窓の中だけを見るので通った。
//    → 書き直しで新しく足された文だけに、聞かれたかを問わない会社の事実の検査を当て、当たれば書き直しを採らない（元の下書きに戻す＝本文を削らない）。
//
// 戻す: FC_ANSWER_KEEP（既定 off・on で①）／FC_REVISION_NO_NEW_FACT（既定 off・on で②）

import { findCompanyFactContradictionsUngated } from "./company-fact-guard";
import { contractProtectsSentence, type TurnContract } from "./turn-contract";
import { diffExitSentences } from "./exit-edits";

type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});

export function fcAnswerKeepEnabled(env?: Env): boolean {
  return (envOf(env).FC_ANSWER_KEEP ?? "").trim().toLowerCase() === "on";
}
export function fcRevisionNoNewFactEnabled(env?: Env): boolean {
  return (envOf(env).FC_REVISION_NO_NEW_FACT ?? "").trim().toLowerCase() === "on";
}

/** 段階の語の ban のうち、答えの文を消しうる3つ（審査・保証会社／契約の手続き／鍵）。message の why で見分ける（line-reply-prompts の PHASE_PROHIBITIONS） */
const ANSWER_BAN_WHY_RE = /審査面・保証会社|審査前の契約|審査前の重要事項|契約前の鍵|内覧段階での審査/;

/** お客様の今の発言が「いつ住めるか・どのくらいかかるか・流れ」を聞いている（ブレインが無い番の予備の網） */
export const MOVE_IN_TIMING_QUESTION_RE =
  /(?:いつ(?:から|頃|ごろ)?|どの(?:くらい|ぐらい|位)|何日|何週間|最短|期間|流れ)[^\n。]{0,20}(?:住め|入居|入れ|引っ?越|契約|審査)|(?:住め|入居|入れ|契約|審査)[^\n。]{0,20}(?:いつ|どの(?:くらい|ぐらい|位)|何日|何週間|最短|かかり|掛かり)/;

/** 入居の時期・流れの答えの文（期間・最短・入居・「〜完了次第ご入居」） */
export const MOVE_IN_ANSWER_SENT_RE = /入居|住め|最短|期間|[0-9０-９]+\s*(?:日|週間|ヶ月|か月)(?:程|ほど|前後|〜|~|から)|流れ|経て/;

/** ブレインが返信で答えると決めた、入居・契約・審査の項目 */
function brainAnswersMoveIn(c: TurnContract | null | undefined): boolean {
  if (!c || c.source !== "brain") return false;
  return c.asks.some((a) => a.route === "reply" && (a.topic === "move_in" || a.topic === "contract" || a.topic === "screening"));
}

/** 探す約束の文（結果の言い切りでない・「探させて頂きます」「ピックアップしてお送りさせて頂きます」） */
const SEARCH_PROMISE_RE = /(?:探|ピックアップ)[^\n。！!]{0,12}(?:させて|して)(?:頂|いただ)きます/;
/** ブレインが探す・送る約束（promise／aix の pickup・property_send）を決めた番 */
function brainPromisesSearch(c: TurnContract | null | undefined): boolean {
  if (!c || c.source !== "brain") return false;
  return c.asks.some((a) => (a.route === "promise" || a.route === "aix") && (a.topic === "pickup" || /property_send|property_recommendation|pickup/.test(a.aixKey ?? "")));
}

/** evidence を含む下書きの文（無ければ evidence そのまま） */
export function sentenceAround(draft: string, evidence: string): string {
  const ev = String(evidence ?? "").trim();
  if (!ev) return "";
  const sents = String(draft ?? "").split(/\n|(?<=[。！!？?])(?![。！!？?])/).map((s) => s.trim()).filter(Boolean);
  return sents.find((s) => s.includes(ev)) ?? ev;
}

export type AnswerKeepIssue = { code: string; message?: string; evidence?: string };

/**
 * ① この指摘を書き直し（接地修正・作り直し）に渡さないか。true＝渡さない（本文はそのまま・指摘は残る）。
 *   当てるのは TIMING_VOCAB_MISMATCH の審査・契約・鍵の ban だけ。次のどれかの時:
 *   a. ブレインが入居・契約・審査の項目を返信で答えると決めた（route=reply）
 *   b. ブレインの約束の文（contractProtectsSentence・例「独立系の保証会社で審査通過の可能性があるお部屋を中心に探させて頂きます」）
 *   c. ブレインの本質が無い番で、お客様の今の発言が入居の時期・流れの質問（MOVE_IN_TIMING_QUESTION_RE）
 */
export function phaseBanKeepsAnswer(
  issue: AnswerKeepIssue,
  o: { contract: TurnContract | null | undefined; draft: string; customerText: string | null | undefined; env?: Env },
): boolean {
  if (!fcAnswerKeepEnabled(o.env)) return false;
  if (issue.code !== "TIMING_VOCAB_MISMATCH") return false;
  if (!ANSWER_BAN_WHY_RE.test(issue.message ?? "")) return false;
  const sent = sentenceAround(o.draft, issue.evidence ?? "");
  // a・c は「入居の時期・流れの答えの文」の時だけ（10/25 実物: 同じ審査の ban の「審査通過後…キャンセルは無料となります」は時期の答えでない＝今までどおり書き直しに渡す）
  const answerSent = MOVE_IN_ANSWER_SENT_RE.test(sent);
  if (answerSent && brainAnswersMoveIn(o.contract)) return true;
  if (sent && contractProtectsSentence(o.contract, sent, envOf(o.env))) return true;
  // contractProtectsSentence は「お探し／ピックアップ」の語だけ見るので、実物の「〜を中心に探させて頂きます」を拾えない（共有の関数は変えずここで補う）
  if (sent && brainPromisesSearch(o.contract) && SEARCH_PROMISE_RE.test(sent)) return true;
  const brain = !!o.contract && o.contract.source === "brain";
  if (!brain && answerSent && MOVE_IN_TIMING_QUESTION_RE.test(String(o.customerText ?? "").normalize("NFKC"))) return true;
  return false;
}

// ─── 2026-11-12 統括役の続き（②の型を広げる・各スイッチ既定 off）────────────────────────────────
// 実物（10/29〜11/11 の書き直し 35件のうち「落とした」12件）から、語の網の block／LLM の指摘がブレインの決めた文を消した型:
//   UKETAMAWARI_OBJECT_UNANCHORED（f6bcf7c4「本日18:30のご内覧のご希望、承りました」・お客様「本日の6時半は空いてないでしょうか」＝語が一致しないだけ・スタッフは内覧の確定で返した）
//   GOCHOUGO_AFTER_FIXED（23837532 お客様「仕事が入って明日でもよろしいでしょうか」＝確定日が変わる番に「ご都合よろしいお時間」を聞くのは正しい・スタッフも時間を聞いた）
//   DOUBLE_DECLARATION／RULE_VIOLATION／GOCHOUGO_NO_CONDITION（7d8086d1 探す約束・ece1900f 写真と動画を送る約束が消えた・スタッフは両方送った）
// 安全の線（FABRICATED_*・BANNED_WORD・NG_PROPERTY_MENTION・AIX_BOUNDARY_*・COMPANY_FACT_*・NAME_*）は対象にしない（コードで限る）。

export function fcUketamawariBrainEnabled(env?: Env): boolean { return (envOf(env).FC_UKETAMAWARI_BRAIN ?? "").trim().toLowerCase() === "on"; }
export function fcGochougoRescheduleEnabled(env?: Env): boolean { return (envOf(env).FC_GOCHOUGO_RESCHEDULE ?? "").trim().toLowerCase() === "on"; }
export function fcPromiseKeepEnabled(env?: Env): boolean { return (envOf(env).FC_PROMISE_KEEP ?? "").trim().toLowerCase() === "on"; }
export function fcPropertyNameNormalizeEnabled(env?: Env): boolean { return (envOf(env).FC_PROPERTY_NAME_NORMALIZE ?? "").trim().toLowerCase() === "on"; }

/** 承りましたの目的語 → ブレインの項目の種類 */
const OBJECT_TOPIC: Array<{ re: RegExp; topics: ReadonlyArray<string> }> = [
  { re: /内覧|内見|ご案内|見学/, topics: ["viewing", "viewing_day"] },
  { re: /費用|見積|金額|家賃/, topics: ["cost", "property_cost"] },
  { re: /条件|ピックアップ|お部屋探し|エリア/, topics: ["pickup", "search_condition"] },
  { re: /申込|契約|審査|入居/, topics: ["contract", "screening", "move_in", "procedure"] },
];
/** UKETAMAWARI の指摘の目的語が、ブレインが今の番で扱うと決めた項目（route が none 以外）の種類に当たるか */
export function uketamawariKeeps(issue: AnswerKeepIssue, o: { contract: TurnContract | null | undefined; env?: Env }): boolean {
  if (!fcUketamawariBrainEnabled(o.env) || issue.code !== "UKETAMAWARI_OBJECT_UNANCHORED") return false;
  const c = o.contract;
  if (!c || c.source !== "brain") return false;
  const obj = `${(issue.message ?? "").match(/「([^」]+)」/)?.[1] ?? ""} ${issue.evidence ?? ""}`;
  const hit = OBJECT_TOPIC.find((t) => t.re.test(obj));
  if (!hit) return false;
  return c.asks.some((a) => a.route !== "none" && (hit.topics.includes(a.topic) || hit.topics.includes(String(a.axis?.about ?? ""))));
}

/** お客様が内覧の日を変えたい・別の日を頼んでいる（確定日がもう確定でない） */
export const RESCHEDULE_RE = /(?:変更|ずら|別の日|他の日|明日(?:で|に)?(?:も|は)|後日|延期|行けなく|行けません|難しく|仕事が入|予定が入|都合が悪|キャンセル(?:して|させ))/;
/** GOCHOUGO_AFTER_FIXED の指摘を、お客様が日の変更を頼んだ番では書き直しに渡さない（ブレインがいる時は内覧の項目を扱う番だけ） */
export function gochougoRescheduleKeeps(issue: AnswerKeepIssue, o: { contract: TurnContract | null | undefined; customerText: string | null | undefined; env?: Env }): boolean {
  if (!fcGochougoRescheduleEnabled(o.env) || issue.code !== "GOCHOUGO_AFTER_FIXED") return false;
  if (!RESCHEDULE_RE.test(String(o.customerText ?? "").normalize("NFKC"))) return false;
  const c = o.contract;
  if (c && c.source === "brain") return c.asks.some((a) => a.route !== "none" && (a.topic === "viewing" || a.axis?.about === "viewing_day"));
  return true;
}

const PROMISE_KEEP_CODES = /^(?:DOUBLE_DECLARATION|RULE_VIOLATION|GOCHOUGO_NO_CONDITION)$/;
const PHOTO_PROMISE_RE = /(?:写真|動画)[^\n。！!]{0,16}(?:撮影|お送り)[^\n。！!]{0,12}(?:させて|して)?(?:頂|いただ)?きます/;
/** ブレインが決めた約束・提案の文を、重複・学習ルール・条件節の指摘で書き直しに渡さない（ブレインが「もう言った」とした文は除く） */
export function promiseKeeps(issue: AnswerKeepIssue, o: { contract: TurnContract | null | undefined; draft: string; env?: Env }): boolean {
  if (!fcPromiseKeepEnabled(o.env) || !PROMISE_KEEP_CODES.test(issue.code)) return false;
  const c = o.contract;
  if (!c || c.source !== "brain") return false;
  const sent = sentenceAround(o.draft, issue.evidence ?? "");
  if (!sent || !PROMISE_SENT_LIKE_RE.test(sent)) return false;
  const key = sent.replace(/[\s！!。😊😌🌟✨]/g, "").slice(0, 14);
  if (c.alreadySaid.some((x) => String(x ?? "").replace(/[\s！!。😊😌🌟✨]/g, "").includes(key.slice(0, 10)))) return false;
  if (contractProtectsSentence(c, sent, envOf(o.env))) return true;
  if (brainPromisesSearch(c) && SEARCH_PROMISE_RE.test(sent)) return true;
  if (PHOTO_PROMISE_RE.test(sent) && c.proposals.some((p) => /撮影|写真|動画/.test(p))) return true;
  return false;
}
const PROMISE_SENT_LIKE_RE = /(?:させて|して)(?:頂|いただ)きます|お送り(?:させて|して)?(?:頂|いただ)?きます|ご連絡(?:させて)?(?:頂|いただ)?きます/;

/** ①と上の3つをまとめた入口（書き直し・作り直しに渡さない指摘か） */
export function fcKeepsBrainSentence(
  issue: AnswerKeepIssue,
  o: { contract: TurnContract | null | undefined; draft: string; customerText: string | null | undefined; env?: Env },
): boolean {
  return phaseBanKeepsAnswer(issue, o) || uketamawariKeeps(issue, o) || gochougoRescheduleKeeps(issue, o) || promiseKeeps(issue, o);
}

/** 物件名の表記ゆれ（全角空白・中黒・号室の有無）を外して比べる形 */
export function normalizePropertyText(s: string): string {
  return String(s ?? "").normalize("NFKC").replace(/[\s　・･\-－ー―‐]/g, "").replace(/号室/g, "").replace(/(?:様|さん)$/g, "");
}
/**
 * FABRICATED_PROPERTY の引用が、表記ゆれを外すと会話（お客様・こちら・資料の値）にそのまま在るか。在れば作り話でない（指摘を外す）。
 *   引用から物件名らしい部分（カタカナ・英字の名前＋号室の数）を取り、全部が在る時だけ。1つでも無ければ外さない（本当の写し間違いは残る）。
 */
export function propertyNameVariantGrounded(code: string, evidence: string | null | undefined, groundTexts: ReadonlyArray<string | null | undefined>, env?: Env): boolean {
  if (!fcPropertyNameNormalizeEnabled(env) || code !== "FABRICATED_PROPERTY") return false;
  const ev = String(evidence ?? "").normalize("NFKC");
  const ground = normalizePropertyText(groundTexts.map((x) => String(x ?? "")).join("\n"));
  if (!ev.trim() || !ground) return false;
  const parts: string[] = [];
  for (const m of ev.matchAll(/[ァ-ヶー][ァ-ヶー\s　・]{2,}[ァ-ヶー]|[A-Za-z][A-Za-z\s　・.\-]{2,}[A-Za-z]/g)) parts.push(normalizePropertyText(m[0]));
  for (const m of ev.matchAll(/(\d{2,4})\s*号室/g)) parts.push(m[1]);
  const named = parts.filter((p) => p.length >= 3);
  if (!named.length) return false;
  return parts.every((p) => /^\d+$/.test(p) ? new RegExp(`(?<!\\d)${p}(?!\\d)`).test(ground) : ground.includes(p));
}

/**
 * ② 書き直しが新しく足した文（元の下書きに無い文）に、会社の事実に反する断定があるか。あれば最初の1文を返す（書き直しを採らない）。
 *   聞かれたかは問わない（書き直しが自分で足した断定なので）。元の下書きにあった文は見ない（1回目の検査の役目）。
 */
export function revisionAddedFactContradiction(before: string, after: string, env?: Env): string | null {
  if (!fcRevisionNoNewFactEnabled(env)) return null;
  const { added } = diffExitSentences(before, after);
  if (!added.length) return null;
  const hits = findCompanyFactContradictionsUngated(added.join("\n"));
  return hits.length ? hits[0].sentence : null;
}
