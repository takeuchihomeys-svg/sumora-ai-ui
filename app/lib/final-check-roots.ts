// final-check-roots.ts — 最終チェックの根の直し（作業員20・2026-11-12・統括役の指示）。各スイッチは既定 off（on の時だけ動く・本文は書き換えない）。
//
// 全読みの穴（fc:* 台帳）のうち根 1・高の穴 1・2・4 の純関数。判断の根拠:
//   ・穴 1  AIX_BOUNDARY_APPLICATION … rule_check のプロンプトは「必要書類は〇〇の3点です」を違反の例にしているが、竹内さん 9/30（feedback_procedure_question_reply）は
//     審査・入居までの期間と流れ・必要書類の質問は返信で説明。ブレインが「返信で答える」と決めた項目の答えの文は、この指摘に当てない（指摘を外すだけ・本文は触らない）
//     → FC_APPLICATION_ANSWER=on
//   ・穴 2  書き直しの指示文の受け身禁止 … 書き直しの指示は「ご条件に合った〜は例外なく絶対禁止」と言うが、検査側（rule_check・10/07）と staff-standard は
//     スタッフの定型（「周辺からご条件に合ったお部屋をピックアップして」等・正解の約6割）として許している。検査と同じ線にそろえる → FC_REVISION_PASSIVE_STAFF=on
//   ・穴 4  修正案と block の文型の食い違い … V2・V3・V12 の修正案が、同じファイルの VIEWING_DATE_ASK_WITHOUT_AIX（block）の文型を提案していた。
//     書き直しの「はい😊禁止」も、開口語の検査（その場で答える返信は「はい」）と逆。修正案は通常返信で許される形（viewingOffer）に、はい禁止はその場で答える返信を除く
//     → FC_SUGGESTION_ALIGN=on
// 根 1 の重みの表は final-check-scope.ts（FC_SEVERITY_TABLE）。

import { sentenceAround } from "./final-check-answer-keep";
import type { TurnContract } from "./turn-contract";

type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});
const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";

export function fcApplicationAnswerEnabled(env?: Env): boolean { return on(envOf(env).FC_APPLICATION_ANSWER); }
export function fcRevisionPassiveStaffEnabled(env?: Env): boolean { return on(envOf(env).FC_REVISION_PASSIVE_STAFF); }
export function fcSuggestionAlignEnabled(env?: Env): boolean { return on(envOf(env).FC_SUGGESTION_ALIGN); }

// ─── 穴 1 ─────────────────────────────────────────────────────────────────────
/** 申込そのものを確定・受理する文（これは AIX の番＝指摘を残す） */
const APPLY_CONFIRMED_RE = /申(?:し)?込(?:み)?(?:を|が|は)?\s*(?:受け付け|受付|受理|完了|確定|承り)|お申込(?:み)?(?:を)?(?:頂|いただ)き(?:ました|ありがとう)|お申込(?:み)?(?:手続き)?を(?:開始|進めま)/;
/** お客様が手続き・書類・審査の流れを聞いている（ブレインの本質が無い番の予備の網） */
export const PROCEDURE_QUESTION_RE = /必要(?:な)?書類|何(?:が|を)必要|どんな書類|書類(?:は|を|って)|審査(?:の|は)?(?:流れ|期間|どのくらい|どれくらい|何日)|入居(?:まで)?の(?:流れ|期間)|申込(?:の|み)?(?:流れ|方法|手続き|手順)/;
const PROCEDURE_ANSWER_RE = /書類|身分証|本人確認|免許|マイナンバー|フォーマット|流れ|審査|期間|手続き/;

function brainAnswersProcedure(c: TurnContract | null | undefined): boolean {
  if (!c || c.source !== "brain") return false;
  return c.asks.some((a) => a.route === "reply" && (a.topic === "screening" || a.topic === "contract" || a.topic === "move_in" || String(a.axis?.about ?? "") === "procedure"));
}

/**
 * AIX_BOUNDARY_APPLICATION の指摘を外すか（true＝外す・本文はそのまま）。
 * 外す条件: 申込を受理・確定する文でなく、かつ（ブレインが手続き・審査・契約を返信で答えると決めた／ブレインが無い番でお客様が手続き・書類を聞いていて答えの文）
 */
export function applicationBoundaryKept(
  issue: { code: string; evidence?: string },
  o: { contract: TurnContract | null | undefined; draft: string; customerText: string | null | undefined; env?: Env },
): boolean {
  if (!fcApplicationAnswerEnabled(o.env)) return false;
  if (issue.code !== "AIX_BOUNDARY_APPLICATION") return false;
  const sent = sentenceAround(o.draft, issue.evidence ?? "");
  if (!sent) return false;
  if (APPLY_CONFIRMED_RE.test(sent) || APPLY_CONFIRMED_RE.test(o.draft)) return false;
  if (!PROCEDURE_ANSWER_RE.test(sent)) return false;
  if (brainAnswersProcedure(o.contract)) return true;
  const brain = !!o.contract && o.contract.source === "brain";
  return !brain && PROCEDURE_QUESTION_RE.test(String(o.customerText ?? "").normalize("NFKC"));
}

// ─── 穴 2・4（書き直しの指示文）─────────────────────────────────────────────────────
const PASSIVE_BLOCK_START = "【🚫 打ち合わせ合意・最高優先度ルール";
const PASSIVE_BLOCK_END = "\n以下の問題が検出されました。";
const PASSIVE_BLOCK_NEW = `【🚫 打ち合わせ合意・最高優先度ルール】
「〇〇さんご希望のご条件に合った〜」のように、お客様を主語にした受け身で、探す・送る行動の宣言になっていない文は、能動表現（例:「〇〇エリアからオススメできるお部屋」「〇〇エリアから探してお届けします」）に直す。
ただし次はスタッフの定型の文（実送信で正解の約6割が使う・竹内さん 10/07）なので、指摘が無い限り変えない: 「〇〇周辺からご条件に合ったお部屋をピックアップして…」（探す行動の宣言の一部）／「〇〇さんにオススメできるお部屋」／「〇〇さんがご満足頂くお部屋が見つかるまで全力でサポート」／「〇〇周辺全域から」。
★エリア名の呼び方は元の文・会話で使われた表現をそのまま維持する。会話で使われていない「全域」等の修飾語を修正時に勝手に付け足さない（例:「日本橋周辺エリア」を「日本橋周辺全域」に変えない）。
`;
const PASSIVE_LINE_RE = /- 【絶対禁止】個人名・エリア名・具体条件の有無を問わず[^\n]*\n/;
const PASSIVE_LINE_NEW = "- お客様を主語にした受け身で行動宣言にならない文は能動表現にする（スタッフの定型「周辺からご条件に合ったお部屋をピックアップして」等は変えない・上の最高優先度ルールのとおり）\n";
const HAI_BAN_OLD = "「はい😊！！」開始（Yes/No質問を除く）／";
const HAI_BAN_NEW = "「はい😊！！」開始（お客様の質問にその場で答える返信・Yes/No質問は「はい」で始めてよい）／";

/** 書き直しの固定の指示文。両スイッチが off なら base を1文字も変えずに返す */
export function revisionStaticFor(base: string, env?: Env): string {
  let t = base;
  if (fcRevisionPassiveStaffEnabled(env)) {
    const s = t.indexOf(PASSIVE_BLOCK_START);
    const e = t.indexOf(PASSIVE_BLOCK_END);
    if (s >= 0 && e > s) t = t.slice(0, s) + PASSIVE_BLOCK_NEW + t.slice(e);
    t = t.replace(PASSIVE_LINE_RE, PASSIVE_LINE_NEW);
  }
  if (fcSuggestionAlignEnabled(env)) t = t.replace(HAI_BAN_OLD, HAI_BAN_NEW);
  return t;
}

// ─── 穴 4（V12 と SCHEDULE_ASSERT の食い違い）────────────────────────────────────────
/** お客様の質問に「はい！！ご案内可能です」と答える形（SCHEDULE_ASSERT の修正案が勧める形）か。V12 の「日時なしのご案内可能です」から外す */
export function guidePossibleIsAnswer(sentence: string, customerText: string | null | undefined, env?: Env): boolean {
  if (!fcSuggestionAlignEnabled(env)) return false;
  return /^(?:[^\n]{0,12}さん)?\s*はい[😊😌]*[！!]/.test(String(sentence ?? "").trim()) && /[?？]|でしょうか|ますか|できますか|出来ますか|可能ですか/.test(String(customerText ?? ""));
}
