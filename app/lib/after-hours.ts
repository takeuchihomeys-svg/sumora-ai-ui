// app/lib/after-hours.ts
// 管理会社の営業時間外（夕方以降）に申込を進めた時の「明日確認してご連絡」の一文と、申込の情報を受け取った時の開口語（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（💜 さん事例）「AIX申込へ 会話を合わせるでこの場合で、はい😊！は文としておかしい。
//   実際に送った文のように 18:00以降の場合、管理会社営業時間外なので このように明日確認して連絡入れる旨いれる。
//   そしてカレンダーには明日連絡午前中に必ず入れるようにする」:
//   19:15 お客様が緊急連絡先（お母様のお名前）を送付 → AIX【申込へ】会話を合わせるの生成は
//     「はい😊！！／お母様のお名前お送り頂きありがとうございます！！／頂きました緊急連絡先情報でお申込み進めさせて頂きます！！／
//      審査結果分かり次第ご連絡させて頂きますので、何卒よろしくお願い致します！！」
//   スタッフの実送信（19:20）は「はい」が無く、締めが
//     「管理会社営業時間外となりますので、明日無事1番手でお申込完了しているか確認出来次第ご連絡させて頂きます！！／何卒よろしくお願い致します！！」
//   実データ（180日・「営業時間外」を含む実送信14件）: 18時台2・19時台4・20時台1・21時台2・23時台1・0時台1（申込・募集状況・交渉すべて同じ型）。
//   実データ（120日・申込の情報を受け取った後の返信92件）: 「はい」で始まるのは2件（2%）＝この場面の開口語ではない。
import { jstParts } from "./jst-date";

/** 管理会社の営業時間（返信生成の管理会社ノートと同じ 9:00〜18:00） */
export const MGMT_OPEN_HOUR = 9;
export const MGMT_CLOSE_HOUR = 18;

/** その時刻（JST）が管理会社の営業時間外か（18:00〜翌 9:00） */
export function isMgmtAfterHours(iso: string | number | Date | null | undefined): boolean {
  if (iso === null || iso === undefined) return false;
  const p = jstParts(typeof iso === "string" || typeof iso === "number" ? iso : iso.toISOString());
  if (!Number.isFinite(p.hour)) return false;
  return p.hour >= MGMT_CLOSE_HOUR || p.hour < MGMT_OPEN_HOUR;
}

/** 申込を進めた時の営業時間外の一文（スタッフの実送信そのまま） */
export const AFTER_HOURS_APPLY_LINE = "管理会社営業時間外となりますので、明日無事1番手でお申込完了しているか確認出来次第ご連絡させて頂きます！！";
/** 既にこの主旨（営業時間外・明日確認）が書かれているか */
const AFTER_HOURS_PRESENT_RE = /営業時間外|翌営業日|明日[^\n]{0,20}(?:確認|ご連絡)/;
/** 締めの決まり文句（この行の前に入れる） */
const CLOSING_TAIL_RE = /^(?:何卒|引き続き)?[^\n]{0,10}?(?:よろしく|宜しく)お願い(?:致します|いたします|します)/;
/** 申込の進行中に「審査結果」を待たせる締め（申込完了の確認が先。営業時間外の一文に置き換える） */
const SCREENING_RESULT_CLOSE_RE = /審査(?:結果|の結果)[^\n]{0,12}(?:分かり|わかり|判明|出|で)次第[^\n]{0,14}(?:ご連絡|ご報告)[^\n]*$/;

/**
 * 営業時間外に申込を進めた返信に「明日確認してご連絡」の一文を入れる（無ければ足す・あれば触らない）。
 *   ・「審査結果分かり次第ご連絡させて頂きますので、」の締めは、まだ申込完了の確認が先なので置き換える
 *   ・「何卒よろしくお願い致します」の行があればその前に入れる（実送信の並び）
 */
export function ensureAfterHoursApplyLine(text: string, afterHours: boolean): string {
  const t = (text ?? "").trim();
  if (!afterHours || !t) return text ?? "";
  if (AFTER_HOURS_PRESENT_RE.test(t)) return text ?? "";
  const lines = t.split("\n");
  // 「審査結果分かり次第ご連絡させて頂きますので、何卒よろしくお願い致します」のような1行は分けてから置き換える
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    // 「審査結果分かり次第ご連絡させて頂きますので、何卒よろしくお願い致します！！」を「〜頂きます」＋「何卒〜」に分ける
    const m = line.match(/^(.*?)(?:ので[、,]\s*)?((?:何卒|引き続き)[^\n]*(?:よろしく|宜しく)お願い(?:致します|いたします|します)[！!。\s]*)$/);
    const head = m ? m[1] : line;
    const tail = m ? m[2] : "";
    if (!replaced && SCREENING_RESULT_CLOSE_RE.test(head.trim())) {
      out.push(AFTER_HOURS_APPLY_LINE);
      if (tail) out.push(tail);
      replaced = true;
      continue;
    }
    out.push(line);
  }
  if (replaced) return out.join("\n");
  // 置き換える締めが無い時は、決まり文句の行の前（無ければ末尾）に足す
  const idx = out.findIndex((l) => CLOSING_TAIL_RE.test(l.trim()));
  if (idx >= 0) out.splice(idx, 0, AFTER_HOURS_APPLY_LINE);
  else out.push(AFTER_HOURS_APPLY_LINE);
  return out.join("\n");
}

/** お客様が申込の情報（申込フォーム・緊急連絡先・勤務先 等）を送ってきた発言か */
export const APPLY_INFO_SENT_RE = /緊急連絡先|勤務先|続柄|フリガナ|年収|雇用形態|勤続年数|住居年数|専業主婦|生年月日|保険種類/;
/** 先頭の裸の相槌（「はい😊！！」だけの行）。次の行が本題（お礼・受領）の時に落とす */
const LEADING_BARE_ACK_RE = /^\s*(?:はい|ええ)[\p{Extended_Pictographic}️\s]*[！!]{0,3}\s*$/u;

/**
 * 申込の情報を受け取った返信の先頭の「はい😊！！」を落とす（実データ 92件中2件しか使われない）。
 * 次の行が「〜お送り頂きありがとうございます」等の受け止めで始まる時だけ落とす（「はい！！ご案内可能です」は触らない）
 */
export function stripLeadingBareAck(text: string): string {
  const t = text ?? "";
  const lines = t.split("\n");
  if (lines.length < 2 || !LEADING_BARE_ACK_RE.test(lines[0] ?? "")) return t;
  const next = (lines[1] ?? "").trim();
  if (!next) return t;
  return lines.slice(1).join("\n").replace(/^\n+/, "");
}
