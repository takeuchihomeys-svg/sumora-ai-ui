// app/lib/application-format.ts
// AIX【申込へ】→ 申込フォーマット送る の本文（画面の固定文）。2026-10-02 AixModal.tsx から移した（中身は変えていない）。
//   同居あり（単独／同居ありの「同居あり」）の時だけ【同居人記入欄】が入る。単独／同居ありは co-resident.ts（入居人数・会話）で先に選び、
//   分からない時は選ばずスタッフが選ぶ（申込へは自動で送らない・staff-confirm-facts）。YUMA の実送信テスト（scripts/yuma-real-line-send-test.ts）も同じ文を使う
export const APP_FORMAT_SECTIONS = {
  applicant: `【お申込者様記入欄】
・入居希望日
・氏名、フリガナ
・生年月日
・現住所 〒（住民票記載）
・住居年数
・住居形態
・携帯番号
・メールアドレス
・配偶者
・勤務先名
・勤務先所在地 〒
・勤続年数
・年収
・雇用形態
・勤務先電話番号
・業種
・職種
・保険種類
・駐輪場利用の有無（台数）
・駐車場利用の有無（台数）
・ペット飼育有無`,
  roommate: `【同居人記入欄】
・氏名、フリガナ
・生年月日
・現住所 （住民票記載〒）
・住居年数
・住居形態
・携帯番号
・メールアドレス
・勤務先名
・勤務先所在地
・勤続年数
・年収
・雇用形態
・勤務先電話番号
・保険種類`,
  emergency: `【緊急連絡先欄】
・氏名、フリガナ
・生年月日
・現住所
・住居年数
・携帯番号
・続柄
・勤務先名
・勤務先所在地`,
  guarantor: `【連帯保証人欄】
・氏名、フリガナ
・生年月日
・現住所 〒（住民票記載）
・住居年数
・住居形態
・携帯番号
・続柄
・勤務先名
・勤務先所在地
・勤続年数
・年収
・雇用形態
・勤務先電話番号`,
};

/** 申込フォーマットの本文（画面の「フォーマット」と同じ組み立て） */
export function buildApplicationFormat(livingType: "single" | "shared", guarantorType: "emergency" | "guarantor"): string {
  const parts = [APP_FORMAT_SECTIONS.applicant];
  if (livingType === "shared") parts.push(APP_FORMAT_SECTIONS.roommate);
  parts.push(guarantorType === "emergency" ? APP_FORMAT_SECTIONS.emergency : APP_FORMAT_SECTIONS.guarantor);
  return parts.join("\n\n");
}
