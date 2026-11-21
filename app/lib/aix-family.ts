// app/lib/aix-family.ts — AIX の系統（どの族の AIX か）の名前を1か所に（純関数・台帳 #313 の②「記録の型を見張り・物差し・試験で同じ名前に」）
//
// 2026-11-22 作業員K2（統括役の頼み・竹内さん 11/13「AIX の種類などの記録も、土台を作って細かい部分は細分化して強化する」）。
//   同じ「AIX の系統」を、3か所が別々の名前・別々の線で持っていた:
//     見張り   line-watch-judge.aixContentFamily … 物件（送る・オススメ・探す・ピックアップ・全力サポート）／確認（物件確認した・確認した・保証会社）／費用（見積書・費用の説明）／内覧（内覧・待ち合わせ）／電話／他はそのまま
//     物差し   scripts/lib/prod-yardstick-db.aixFamily … 確認／見積（← 費用）／物件（全力サポートは入れない＝サポート）／内覧／申込／サポート／保証会社はそのまま
//     試験     scripts/lib/brain-exam-score.aixFamily … 物件（4種）／acknowledge_check は property_check_result／他（見積書も）はそのまま
//   同じ番を、見張りは「当たり」・物差しは「外れ」と数える所があった（全力サポート・保証会社・見積の名前）。
// 決め: 見張りの系統（2026-10-13 v7・竹内さんの番を読んで決めた線）を元にし、物差しにだけあった 申込 を足す。名前は 物件／確認／費用／内覧／電話／申込。
//   既定はどこも今まで通り（AIX_FAMILY_ONE=on の時だけ、物差しもこの関数で数える）。見張りの系統の種類にはこの関数も同じ答えを返す（テストで固定）。
//   試験の採点（brain-exam-score.aixFamily）は正解の文字（AIX:物件・AIX:property_check_result）と照らす鍵なので変えない（名前を変えると正解と合わなくなる）。
// テスト: app/lib/__tests__/aix-family.test.ts
type Env = Record<string, string | undefined>;
export function aixFamilyOneOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.AIX_FAMILY_ONE ?? "").trim().toLowerCase() === "on";
}
export const AIX_FAMILIES = ["物件", "確認", "費用", "内覧", "電話", "申込"] as const;
/** AIX の種類（"ボタン" か "ボタン/ピッカー"）→ 系統。系統に入らない物は種類のまま */
export function aixFamilyOf(keyOrAix: string | null | undefined): string {
  const a = String(keyOrAix ?? "").split("/")[0].trim();
  if (/^property_(?:send|recommendation|search|pickup)$/.test(a) || a === "zenryoku_support" || a === "new_arrival") return "物件";
  if (a === "property_check_result" || a === "acknowledge_check" || a === "guarantor_info") return "確認";
  if (a === "estimate_sheet" || a === "cost_breakdown" || a === "cost_explain") return "費用";
  if (a === "meeting_place" || a === "viewing_invite") return "内覧";
  if (a === "phone_call") return "電話";
  if (a === "application_push" || a === "application_form") return "申込";
  return a;
}
