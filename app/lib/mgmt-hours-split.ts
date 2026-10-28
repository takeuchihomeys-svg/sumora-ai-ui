// app/lib/mgmt-hours-split.ts — 確認の「いつ」の線（純関数）
//
// 2026-10-28 竹内さんの決定（KB 5d9e56b5・9fd703f4・今週の LINE #26 Ryoichi・#28 あかり）:
//   募集状況（空き）の確認は業者の物件サイト（リアプロ・ITANDI・レインズ）で弊社の営業時間中に確かめられる＝18時以降でも「明日」を付けない。
//   管理会社にしか答えられない確認・交渉（駐車場・鍵交換の免除・ペット 等）だけ、18時以降は「本日管理会社営業時間外の為明日…」。
// 切替: MGMT_HOURS_SPLIT_1028=on の時だけ（既定 off）。テスト: app/lib/__tests__/mgmt-hours-split.test.ts
export function mgmtHoursSplitEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_HOURS_SPLIT_1028 ?? "").trim().toLowerCase() === "on";
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
