// app/lib/engagement-text-mask.ts — 返信後のお客様の反応の記録（reply_engagement_signals.customer_reply_text）に、
//   記入済みの申込フォーム・個人の値をそのまま残さない（純関数）。
//
// 2026-11-15 作業員H（統括役の頼み・竹内さんの OK「個人情報は伏せる」）:
//   line-webhook-text.resolveEngagementSignal がお客様の返信の先頭 200字を customer_reply_text に入れていた＝申込フォームを送った返信だと
//   氏名・フリガナ・生年月日・住所・携帯・メール・勤務先がそのまま残った（全期間 約120行）。この列を LLM の材料に読む所は app・scripts・DB 関数に無い
//   （11/15 に確かめた）が、表に個人の値を置かない。入口で伏せる（既定 on・ENGAGEMENT_TEXT_MASK=off で前の形）。
//   形: 申込の書類・個人の値の通は、個人の欄（氏名・住所・電話・勤務先…）の値と、欄の無い行を「〇〇」に。入居希望日・駐輪場・駐車場・ペットの行は残す。
//   申込の通でない時も、携帯・メール・郵便番号・生年月日の値は「〇〇」に。
import { applicationMaterialReason } from "./test-pii-guard";
import { isApplyPaperText } from "./condition-source-gate";

type Env = Record<string, string | undefined>;
export function engagementTextMaskOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.ENGAGEMENT_TEXT_MASK ?? "").trim().toLowerCase() !== "off";
}

const MASK = "〇〇";
const KEEP_LABEL_RE = /^(?:入居希望日|入居日|駐輪場|駐車場|ペット|お申込者様記入欄|同居人記入欄|【)/;
const VALUE_RES: RegExp[] = [
  /0[789]0[-‐－ー\s]?\d{4}[-‐－ー\s]?\d{4}/g,
  /0\d{1,4}-\d{1,4}-\d{3,4}/g,
  /[\w.+-]+@[\w-]+\.[\w.]+/g,
  /〒\s*\d{3}[-‐－ー]?\d{4}/g,
  // 生年月日らしい日付だけ（2009年以前・和暦の昭和平成）。入居日・内覧日（2026年…）は伏せない
  /(?:19\d{2}|200\d)\s*[年/.\-]\s*\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?/g,
  /(?:昭和|平成)\s*\d{1,2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g,
];
const URL_RE = /https?:\/\/[^\s]+/g;
function maskValues(t: string): string {
  const urls: string[] = [];
  let s = t.replace(URL_RE, (u) => { urls.push(u); return `\u0000${urls.length - 1}\u0000`; });
  for (const re of VALUE_RES) s = s.replace(re, MASK);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => urls[Number(i)] ?? "");
}
/** 番地までの住所（都道府県＋市区町村＋数字）。欄の名前の無い住所の貼り付け（申込の値を並べて送る形）を拾う */
const ADDRESS_RE = /(?:都|道|府|県)[^\s\n]{1,12}?(?:市|区|郡|町|村)[^\s\n]{0,20}?\d{1,4}\s*[-‐－ー丁番]\s*\d/;
/** 申込の書類・個人の値の通か（URL の中の数字は見ない） */
export function isApplicationLikeText(t: string): boolean {
  const s = t.replace(URL_RE, " ");
  return !!applicationMaterialReason(s) || isApplyPaperText(s) || ADDRESS_RE.test(s) || maskValues(s) !== s;
}
/** 記録に入れる形（伏せた後） */
export function maskEngagementText(raw: string | null | undefined): string {
  const t = String(raw ?? "");
  if (!t) return t;
  if (!isApplicationLikeText(t)) return maskValues(t);
  return t.split("\n").map((line) => {
    const l = line.trim();
    if (!l) return line;
    const head = l.replace(/^[・•\-*＊\s]+/, "");
    if (KEEP_LABEL_RE.test(head)) return maskValues(line);
    // 「欄の名前 値」「欄の名前：値」→ 欄の名前だけ残す（欄の名前は伏せない＝何の欄だったかは分かる）
    const m = head.match(/^([^\s:：、]{1,14}?)(?:\s*[:：]\s*|\s+)(.+)$/);
    if (m && /氏名|フリガナ|名前|生年月日|住所|住居|携帯|電話|メール|配偶者|勤務先|勤続|年収|雇用|業種|職種|保険|同居|緊急連絡|連帯保証|続柄|〒/.test(m[1])) return `・${m[1]} ${MASK}`;
    // 値の無い欄の名前だけの行（フォームの見出しそのもの）は残す。「住居形態賃貸」「年収300万」のように値が続く物は伏せる
    if (/^(?:氏名、?\s*フリガナ|氏名|フリガナ|生年月日|現住所[^\s]{0,8}|住所|住居年数|住居形態|携帯番号|メールアドレス|配偶者|勤務先名|勤務先|勤務先所在地[^\s]{0,4}|勤続年数|年収|雇用形態|勤務先電話番号|業種|職種|保険種類|続柄)\s*$/.test(head)) return line;
    return MASK;
  }).join("\n");
}
