// scripts/lib/combo-of-moves.ts — 竹内さんの実送信から「返信と AIX の組」を読む（純関数・2026-11-13 作業員7b・scripts/audit-combo-vs-takeuchi.ts が使う）
import type { SendCombo } from "../../app/lib/send-combo-table";

export type StaffMove = { at: number; aix: boolean; writer: string | null; customer?: boolean; /** AIX の種類（aix_usage_logs の近い行から・assignAixKinds） */ aixKind?: string | null };
/** 物件オススメ＋ピックアップは1つの束（オススメ1＋9 の型・竹内さんの初回10件）。同じ束の AIX が続くのは AIX → AIX ではない */
const bundleOf = (k: string | null | undefined): string | null => { const b = String(k ?? "").split("/")[0]; return /^(?:property_send|property_recommendation)$/.test(b) ? "property_bundle" : b || null; };
/**
 * 2026-11-19 作業員M（台帳 #404・組の表の次の穴: 物件を送る でブレインは AIX だけ・竹内さんは AIX → AIX 19件／60日）:
 *   AIX の通に種類を付ける（その通の時刻の前10分〜後2分に押した AIX の記録・staff-first-move と同じ線）。付けられない通は null のまま
 */
export function assignAixKinds(moves: readonly StaffMove[], aixLogs: ReadonlyArray<{ at: number; aixType: string }>): StaffMove[] {
  return moves.map((m) => {
    if (!m.aix || m.aixKind) return m;
    const near = aixLogs.filter((a) => a.at >= m.at - 10 * 60_000 && a.at <= m.at + 2 * 60_000).sort((a, b) => Math.abs(a.at - m.at) - Math.abs(b.at - m.at))[0];
    return near ? { ...m, aixKind: near.aixType } : m;
  });
}
/** 竹内さんの組（純関数）。moves はお客様の番の後の通（時刻順・お客様の次の発言で切る） */
export function takeuchiCombo(turnAt: number, moves: readonly StaffMove[]): SendCombo | null {
  const ms: StaffMove[] = [];
  for (const m of [...moves].filter((x) => x.at >= turnAt && x.at - turnAt < 24 * 3_600_000).sort((a, b) => a.at - b.at)) { if (m.customer) break; ms.push(m); }
  if (!ms.length) return null;
  // AIX の通（画像・本文が続く）は1つにまとめる（60秒以内に続く AIX の通）
  const seq: StaffMove[] = [];
  //   2026-11-19 作業員M: 同じ束の AIX（オススメ＋ピックアップ）は、間に返信が無く10分以内なら1つ（種類が付いている時だけ・付いていなければ今まで通り60秒）
  for (const m of ms) {
    const last = seq[seq.length - 1];
    if (last && last.aix && m.aix && m.at - last.at <= 60_000) continue;
    if (last && last.aix && m.aix && m.at - last.at <= 10 * 60_000 && bundleOf(last.aixKind) && bundleOf(last.aixKind) === bundleOf(m.aixKind)) { last.at = m.at; continue; }
    seq.push({ ...m });
  }
  const [a, b] = seq;
  if (!a.aix) {
    const firstAix = seq.find((m) => m.aix);
    if (firstAix && firstAix.at - a.at <= 120_000) return "reply_then_aix_quick";
    if (firstAix) return "promise_then_aix_later";
    return b && !b.aix && b.at - a.at <= 10 * 60_000 ? "reply_reply" : "reply_only";
  }
  if (b && !b.aix && b.at - a.at <= 10 * 60_000) return "aix_then_reply";
  if (b && b.aix && b.at - a.at <= 10 * 60_000) return "aix_then_aix";
  return "aix_only";
}

/**
 * 2026-11-21 作業員M（台帳 #407・統括役の頼み・作業員N の組の一致の毎日の数 11/19 まで14日・竹内さん本人の番 31・外れ 17）:
 *   外れ 17 を軽く読んだら 11 は数え方の側だった（表に足りない組は無かった）:
 *     ① 2段（約束の返信→後で AIX）を竹内さんの「返信だけ」と数えた 4（9faff2ec×2・6c9dd6b7×2）: 竹内さんの AIX はお客様の次の発言の後（約24時間以内）に来ていた＝
 *        takeuchiCombo はお客様の次の発言で切るので、2段の1通目しか見えない → laterAixWithinMs の間に竹内さんの AIX があれば同じ組と数える
 *     ② ブレインの組の手がかりに AIX の種類・条件ヒアリング・問いの数が入っていなかった 6（物件を送る 3・見積書 1・条件ヒアリング 1・2つの問い 1）＝
 *        本番の comboCuesFromMeta は aixKind・hearing・multiTopics を入れる（数える側の pickSendCombo の手がかりを本番にそろえる＝作業員N の combo-daily）
 *     ③ 同じ物件確認した の AIX が2分空いて続いた 1（a8c55dde）＝種類が付けば束になる（assignAixKinds の記録の時刻の窓）
 *   残り 6 は返信か AIX かの判断の外れ（台帳 #405 の線・今夜）: 615499ba 申込へ→返信／2d7548d5 結果が手元なのに2段／2cb0feb7・0330a81a・a8c55dde 10:59 返信→AIX／65c2df5b
 */
/**
 * 2026-11-21 作業員M（台帳 #405 の入口の表・2cb0feb7 の型・統括役の頼み）: 前の番でこちらが約束した事を果たす AIX は、この番の組に数えない。
 *   例 2cb0feb7: こちら「募集状況確認させて頂きます」「ピックアップしてお送りさせて頂きます」→お客様「ご協力ありがとうございます」→竹内さん「確認出来次第ご連絡」→1時間後に AIX【物件確認した】【物件を送る】
 *   ＝この番の竹内さんの手は返信だけ。後の AIX は前の番の約束の果たし（この番の判断ではない）。
 *   判定は語の網（前の番のこちらの通の約束の語 × AIX の種類の仲間）。数え方だけで本番の動きは変えない。
 */
const PREV_PROMISE_OF: ReadonlyArray<[RegExp, RegExp]> = [
  [/^property_check_result/, /募集状況(?:を)?確認|空き(?:状況)?(?:を)?確認|確認させて頂きます|確認出来次第|確認でき次第/],
  [/^(?:property_send|property_recommendation)/, /ピックアップ(?:して|させて)|お送りさせて頂きます|お探し(?:して|させて)|新着(?:で|が)/],
  [/^estimate_sheet/, /御?見積(?:書)?(?:を)?(?:作成|お作り|お送り)/],
];
/** この番の後の AIX（種類）が、番より前のこちらの通（prevStaffTexts）の約束を果たす物か */
export function aixFulfilsPrevPromise(aixKind: string | null | undefined, prevStaffTexts: readonly string[]): boolean {
  const k = String(aixKind ?? "");
  const row = PREV_PROMISE_OF.find(([kr]) => kr.test(k));
  if (!row) return false;
  return prevStaffTexts.some((t) => row[1].test(String(t ?? "")));
}
/** 竹内さんの組から「前の番の約束を果たす AIX」を除いた組（この番の手だけ）。除くと返信が無い組は null（この番の手が無い） */
export function comboWithoutPrevFulfil(takeuchi: SendCombo | null | undefined): SendCombo | null {
  if (takeuchi === "promise_then_aix_later" || takeuchi === "reply_then_aix_quick") return "reply_only";
  if (takeuchi === "reply_only" || takeuchi === "reply_reply") return takeuchi;
  return null;
}
export function comboMatches(brain: SendCombo | null | undefined, takeuchi: SendCombo | null | undefined, o: { laterAixWithinMs?: number | null; laterAixFulfilsPrev?: boolean } = {}): boolean {
  if (!brain || !takeuchi) return false;
  if (brain === takeuchi) return true;
  // 竹内さんの AIX が前の番の約束を果たす物なら、この番の組はその AIX を除いた物で比べる（除いて手が無ければ比べない＝一致にしない）
  if (o.laterAixFulfilsPrev) { const own = comboWithoutPrevFulfil(takeuchi); if (own && own === brain) return true; }
  // 2段の1通目＝約束の返信。竹内さんの AIX が次の発言の後に来た番は同じ組（約束を果たした先が見えている時だけ）
  if (brain === "promise_then_aix_later" && takeuchi === "reply_only" && o.laterAixWithinMs != null && o.laterAixWithinMs <= 48 * 3_600_000) return true;
  return false;
}
