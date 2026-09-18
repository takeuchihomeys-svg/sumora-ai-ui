// app/lib/waiting-commitment.ts
// 「待ち」が生まれた場面で、お礼で終わらせずに“次にこちらがいつ何をするか”を約束する（純関数・DB 依存なし）。
//
// 2026-09-18 竹内（𝒮❦ 事例）「生成された文のように軽い文ではなくて、この状況だと**お客さんと約束して**
//   （状況が分かってるんやから）信頼関係を結ぶ形とする。そうしたら成約率も上がるから」
//
// 【場面】こちらが入居時期を交渉・確認して「お客様がいつ頃お申込みすればよいか」を報告し、
//   お客様が了承だけ（かしこまりました／ありがとうございます）を返した。
//     スタッフ ①「お申込みから1ヶ月半が最長でのご入居設定日とのご回答でした！！
//                11月中旬ごろのご入居の場合、9月末ごろにお申込みいただきますと11月中旬頃ご入居可能となります😊！！」
//     お客様  ②「かしこまりました🙏 ありがとうございます」
//     旧の生成 ③「はい😊！！ ご確認頂きありがとうございます！！ 何卒よろしくお願い致します！！」← 軽い
//     実送信   ③「はい😊！！ 9月30日に一度9月30日時点での募集状況をご連絡させて頂きます！！
//                その間もお部屋抑えられる場合や気になる点出てきましたらお気軽にご連絡ください！！
//                引き続き何卒よろしくお願い致します！！」
//
// 【実データ（365日）で確かめたこと】
//   ・了承だけへの返し 522件のうち、こちらから次の一手を約束しているのは 13%（申込まで進んだ会話でも 13%）。
//     ＝「毎回約束する」は実態ではない。だから**待ちが生まれた場面だけ**に絞る。
//   ・この場面（入居時期の交渉→申込の目安日を報告）は 22件/年。同じ場面の過去の返しは
//     08/26 YUYA が軽い返し・09/18 𝒮❦ が日付つきの約束＝**今回の形は竹内さんが新しく決めた型**（多数派ではない）。
//   ・言い回しの骨組みは実送信にある物だけを使う（feedback_no_invented_phrases）:
//     「お気軽にご連絡ください」188件 ／「引き続き〜次第ご連絡させて頂きます」68件 ／
//     「{日付}に一度{日付}時点での募集状況をご連絡させて頂きます」は 09/18 の1件（竹内さんの実送信）。

import { jstParts } from "./jst-date";

/** 待ちの種類（今は「申込の目安日が決まった」だけ。増やす時は必ず実送信で骨組みを確かめる） */
export type WaitKind = "apply_by";

export type WaitingSituation = {
  kind: WaitKind;
  /** 次にこちらから連絡する日（＝お客様が動く目安の日）。JST の月日 */
  contactDate: { month: number; day: number };
  /** 元の言い回し（証拠。生成に渡して、この日付以外を書かせないため） */
  evidence: string;
};

const ZEN_DIGITS = "０１２３４５６７８９";
function toHalf(s: string): string {
  return s.replace(/[０-９]/g, (c) => String(ZEN_DIGITS.indexOf(c)));
}

/**
 * 申込の目安日を伝えた文（実データ 22件の言い回しから）。
 * 日付と「お申込み」の間に「入居」を挟まない＝その日付が**入居の希望日**の時は拾わない。
 *   ×「10月末ご入居ですと、お申込は9月末頃を目安に…」の 10月末（入居日）→ 後ろの 9月末 を拾う
 *   ×「8月1日ご入居でお申込みしお部屋抑えさせて頂きます」（こちらが今すぐ申し込む＝待ちではない）
 */
const APPLY_BY_RE =
  /([0-9０-９]{1,2})\s*[月\/／]\s*(末|[0-9０-９]{1,2})\s*日?\s*(?:ごろ|頃|辺り|あたり|目安|まで)?[^\n。！!入居]{0,18}お?申込み?/;
/** 「お申込み」が、こちらが今すぐ行う手続きを指す文は待ちではない */
const ALREADY_APPLIED_RE = /お?申込み?(?:させて(?:頂|いただ)き|し|を|進め)[^\n。！!]{0,12}(?:ました|ます|抑え|進め|完了)/;
/** 入居時期の話であること（この場面の目印） */
const MOVE_IN_CONTEXT_RE = /(?:ご入居|入居)/;

/** その月の末日（JST） */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 直前のスタッフ発言から「待ちが生まれたか」と「次にこちらが連絡する日」を取り出す。
 * 取れない時は null（＝この仕組みは何もしない。安全側）。
 */
export function resolveWaitingSituation(
  lastStaffText: string | null | undefined,
  nowIso: string,
): WaitingSituation | null {
  const text = (lastStaffText ?? "").trim();
  if (!text || !MOVE_IN_CONTEXT_RE.test(text)) return null;
  if (ALREADY_APPLIED_RE.test(text)) return null;
  const m = text.match(APPLY_BY_RE);
  if (!m) return null;

  const month = Number(toHalf(m[1]));
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;

  const now = jstParts(nowIso);
  if (!Number.isFinite(now.y)) return null;
  // 月だけが先に来ている場合は「次に来るその月」（12月に1月と言われたら翌年）
  const year = month < now.m ? now.y + 1 : now.y;

  let day: number;
  if (m[2] === "末") {
    day = lastDayOfMonth(year, month);
  } else {
    day = Number(toHalf(m[2]));
    if (!Number.isInteger(day) || day < 1 || day > lastDayOfMonth(year, month)) return null;
  }

  return { kind: "apply_by", contactDate: { month, day }, evidence: m[0] };
}

/** 「9月30日」 */
export function contactDateLabel(s: WaitingSituation): string {
  return `${s.contactDate.month}月${s.contactDate.day}日`;
}

/**
 * 約束の1文（実送信の骨組み・2026-09-18 𝒮❦）。
 * 日付は直前のスタッフ発言から取った値だけを使う（こちらで日を作らない）。
 */
export function waitingContactLine(s: WaitingSituation): string {
  const d = contactDateLabel(s);
  return `${d}に一度${d}時点での募集状況をご連絡させて頂きます！！`;
}

/** 間の窓口の1文（実送信 188件の「お気軽にご連絡ください」の形） */
export const WAITING_DOOR_LINE = "その間もお部屋抑えられる場合や気になる点出てきましたらお気軽にご連絡ください！！";

/** この約束が入っているか（必須要素の detect・出口の差し込みが同じ判定を使う＝四者同名） */
export const WAITING_COMMITMENT_RE =
  /[0-9０-９]{1,2}\s*月\s*[0-9０-９]{1,2}\s*日[^\n。！!]{0,30}(?:ご連絡|ご報告)(?:させて(?:頂|いただ)き|いたし|致し)ます/;

/** 生成への指示（必須要素のラベル。文例をそのまま載せる＝名前だけでは書かれない） */
export function waitingCommitmentLabel(s: WaitingSituation): string {
  return `次にこちらから連絡する日の約束「${waitingContactLine(s)}」` +
    `（お客様は「${s.evidence}」を受けて了承しただけ。お礼で終わらせず、いつ何をご連絡するかを約束する。日付はこの日以外を書かない）`;
}

/** 修正ループ用の直し方 */
export function waitingCommitmentFix(s: WaitingSituation): string {
  return `「${waitingContactLine(s)}」を1文入れる（日付は${contactDateLabel(s)}だけ。` +
    `続けて「${WAITING_DOOR_LINE}」を入れてもよい。新しい約束・金額・物件名は書かない）`;
}

/** 締めの行（この直前に差し込む）。実送信の締めの形 */
const CLOSER_RE = /^(?:引き続き)?(?:何卒)?よろしくお願い(?:致します|いたします|します)[！!]*$/;

/**
 * 出口の保証。約束の文が無ければ締めの直前（無ければ末尾）に足す。
 * 生成が書けていても二重にしない。
 */
export function ensureWaitingCommitment(text: string, s: WaitingSituation | null): string {
  if (!s) return text;
  const body = (text ?? "").trimEnd();
  if (!body) return text;
  if (WAITING_COMMITMENT_RE.test(body)) return text;
  const lines = body.split("\n");
  let at = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (CLOSER_RE.test(t)) { at = i; continue; }
    break;
  }
  lines.splice(at, 0, waitingContactLine(s), WAITING_DOOR_LINE);
  return lines.join("\n");
}
