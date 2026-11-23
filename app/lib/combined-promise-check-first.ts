// app/lib/combined-promise-check-first.ts — 「募集状況の確認＋御見積書」を両方約束した後、お客様が2件以上の物件を送ってきていた時は
//   AIX【見積書送る】ではなく【物件確認した】（見積を同封して募集中のお部屋を報告する形）を先に立てる（純関数・既定 off）
//
// 2026-11-23 作業員K2（台帳 #469・作業員A の種類違い 17208・統括役の頼み）。
//   17208（82c4d3e8・11/22）: お客様が物件を3件送る→こちら「〇〇の募集状況と初期費用確認させて頂きます！！確認出来次第…御見積書とあわせてご連絡」
//   →お客様「大体見積もりいつ頃ご連絡いただけそうですか？」に、two-stage の answerableDirectAix（見積）が【見積書送る】を立てた。
//   竹内さんは【物件確認した】（「募集状況と最大限割引しました初期費用御見積させて頂きました！！【募集中のお部屋】●…」＋見積の画像）。
// 実送信で数えた（120日・同じ約束の文の後に竹内さんが最初に押した AIX・お客様が約束の前24時間に送った物件の数ごと）:
//   0件: 物件確認した 11・見積書 11（割れる）／1件: 物件確認した 7・見積書 11（割れる）／2件以上: 物件確認した 7・見積書 2（78%）
//   （従業員は全体で 物件確認した 36・見積書 1）。過半数の形があるのは2件以上だけ＝そこだけ決まりにする（0〜1件は今のまま）。
// ■ スイッチ COMBINED_PROMISE_CHECK_FIRST: 既定 off（何もしない）／on（brain-core の answerable_direct の後で見積書を物件確認した に）
// テスト: app/lib/__tests__/combined-promise-check-first.test.ts
type Env = Record<string, string | undefined>;
export function combinedPromiseCheckFirstOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.COMBINED_PROMISE_CHECK_FIRST ?? "").trim().toLowerCase() === "on";
}

export type CpMsg = { sender: string; text: string | null; created_at: string; image_url?: string | null };
/** 募集状況の確認と御見積書を両方約束した文（数えた時の線と同じ） */
const VACANCY_RE = /(?:募集状況|空室状況|空き状況|空き)[^。！!\n]{0,25}確認/;
const PROMISE_FORM_RE = /させて(?:頂|いただ)き|次第/;
/** お客様が送ってきた物件（URL・ポータルの共有文・画像） */
const BROUGHT_RE = /https?:\/\/|物件名|^\[画像\]/;
const WINDOW_PROMISE_MS = 3 * 86_400_000;
const WINDOW_BROUGHT_MS = 24 * 3_600_000;

/**
 * @param direct ブレインが立てようとしている AIX（answerable_direct の行き先）
 * @param messages 会話（古い順）
 * @param nowMs 今（判断の時刻）
 * @returns 物件確認した に替える時だけ "property_check_result"・それ以外 null
 */
export function combinedPromiseCheckFirst(direct: string | null | undefined, messages: ReadonlyArray<CpMsg>, nowMs: number): "property_check_result" | null {
  if (direct !== "estimate_sheet") return null;
  let promiseIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.sender === "customer") continue;
    const at = Date.parse(m.created_at);
    if (Number.isFinite(at) && nowMs - at > WINDOW_PROMISE_MS) break;
    const t = String(m.text ?? "");
    if (VACANCY_RE.test(t) && /見積/.test(t) && PROMISE_FORM_RE.test(t)) { promiseIdx = i; break; }
    // 約束の後にもうこちらが AIX・報告を送っていれば（見積・確認の報告）、開いている約束ではない
    if (/御見積書|募集中のお部屋|募集状況確認させて頂きました/.test(t)) return null;
  }
  if (promiseIdx < 0) return null;
  const pAt = Date.parse(messages[promiseIdx].created_at);
  let brought = 0;
  for (let i = promiseIdx - 1; i >= 0; i--) {
    const m = messages[i];
    const at = Date.parse(m.created_at);
    if (Number.isFinite(at) && Number.isFinite(pAt) && pAt - at > WINDOW_BROUGHT_MS) break;
    if (m.sender === "customer" && (BROUGHT_RE.test(String(m.text ?? "")) || !!m.image_url)) brought++;
  }
  return brought >= 2 ? "property_check_result" : null;
}
