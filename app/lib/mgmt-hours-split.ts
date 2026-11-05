// app/lib/mgmt-hours-split.ts — 確認の「いつ」の線（純関数）
//
// 2026-10-28 竹内さんの決定（KB 5d9e56b5・9fd703f4・今週の LINE #26 Ryoichi・#28 あかり）:
//   募集状況（空き）の確認は業者の物件サイト（リアプロ・ITANDI・レインズ）で弊社の営業時間中に確かめられる＝18時以降でも「明日」を付けない。
//   管理会社にしか答えられない確認・交渉（駐車場・鍵交換の免除・ペット 等）だけ、18時以降は「本日管理会社営業時間外の為明日…」。
// 切替: MGMT_HOURS_SPLIT_1028（2026-11-05 既定 on・=off で戻す。作業員9 の試験 mgmt-split-on 悪化0・q197 は揺れ＝ブレインの判断に触らない・竹内さんの決定 P1 5d9e56b5／5fe999f8 の2回）。テスト: app/lib/__tests__/mgmt-hours-split.test.ts
export function mgmtHoursSplitEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_HOURS_SPLIT_1028 ?? "").trim().toLowerCase() !== "off";
}

/** 弊社の営業の終わり（JST の時）。やることリストの最後の便は 20:30・電話は19時まで＝確かめ待ち（竹内さんに答え待ち） */
export const COMPANY_CLOSE_HOUR = 21;

/** 確認の対象が空き・募集状況だけか（駐車場・鍵交換・ペット・交渉 等が入っていれば管理会社の確認） */
export function isVacancyConfirmObject(object: string | null | undefined): boolean {
  const o = String(object ?? "").trim();
  if (!o) return false;
  if (/駐車|駐輪|バイク|鍵|ペット|猫|犬|交渉|値下|割引|礼金|敷金|フリーレント|設備|入居(?:可能)?日|保証|審査|契約|退去|楽器|二人|法人/.test(o)) return false;
  return /募集状況|空室|空き|募集/.test(o);
}

/**
 * 夜の管理会社への確認の結び（2026-11-05 作業員9・弱い所 324・KB P1 9fd703f4）。
 *   なぜ: 2段の確認の番は、ブレインの返信の方向（two-stage の direction「結びは『確認出来次第ご連絡させて頂きます！！』」）が
 *   本質の帯の一番上に入り、下の【管理会社の状況】の「明日」の指示より勝っていた（試験 q136＝8/23 20:38 の番・前も今も「明日」が無い）。
 *   竹内さん本人の夜（18時以降）の管理会社への確認の送信は、ほぼ全部「明日」を付けている:
 *     8/23 20:54「礼金の交渉と駐車場の空き状況について、管理会社に確認させて頂きます！！ 管理会社営業時間外ですので明日確認し 確認出来次第ご連絡」（q136 の番そのもの）
 *     10/26 18:45「本日管理会社営業時間外の為明日交渉、確認させていただき確認出来次第ご連絡」・8/24 18:11・9/10 22:24・8/25 23:38（例外は 9/06 20:59 の駐車場料金の1通）
 *   何を: ブレインの方向のすぐ下に1行だけ足し、結びの前に「本日管理会社営業時間外の為、明日」を入れさせる（ブレインの判断・結びの言葉は変えない）。
 *   入れない: 確認の約束が無い番・土日（交渉は月曜の別の注記）・朝（9時前）・募集状況だけの確認で21時より前（10/28 の決定＝今すぐ確かめられる）。
 * 切替: MGMT_NIGHT_CLOSING=on の時だけ（既定 off）。
 */
export function mgmtNightClosingOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_NIGHT_CLOSING ?? "").trim().toLowerCase() === "on";
}
export function nightMgmtClosingLine(o: { hour: number; weekend: boolean; allowed: boolean; object: string | null | undefined; splitOn: boolean }): string | null {
  if (!o.allowed || o.weekend) return null;
  if (!(o.hour >= 18)) return null;
  const vacancy = isVacancyConfirmObject(o.object);
  if (vacancy && o.splitOn && o.hour < COMPANY_CLOSE_HOUR) return null;
  const obj = String(o.object ?? "").trim();
  return `- 🕘 夜の確認の約束（${o.hour}時台・管理会社の営業時間外）: 上の結び「確認出来次第ご連絡させて頂きます！！」の前に「本日管理会社営業時間外の為、明日${obj ? `${obj}を` : ""}確認させて頂き、」を入れて1文にする（竹内さんの実送信の形・当日中の答えを約束しない・ほかの中身は上のまま）`;
}
