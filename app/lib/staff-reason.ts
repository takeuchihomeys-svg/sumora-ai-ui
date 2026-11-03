// app/lib/staff-reason.ts — スタッフの理由のワンタップ（土台の8つ ⑦・2026-11-03 作業員1）
//
// AI の下書きと違う文を送った時に、理由を1回押すだけで残す（任意・押さなくてよい）。
// 選択肢は竹内さんの絶対の考え方（P0・feedback_aix_reply_split）の外れの3つの原因＋言い回し:
//   staff_only … スタッフだけが知る事を入れた（管理会社に確認した事・募集状況・金額・日程の確定）＝本来 AIX で送る番（③）
//   material   … 会話・資料にある事を AI が入れていなかった（①材料が届いていない）
//   scene      … 場面・決まりが違う（②読み違い）
//   wording    … 言い回しだけ（中身は同じ）
// 記録: brain_decision_logs.staff_reason（＋staff_reason_at）。毎晩の自動の学び・毎週の原因の表が数える
// 出す: NEXT_PUBLIC_STAFF_REASON_TAP=on の時だけ（既定 off）。下書きを直して送った（draft_modified）か、下書きがあったのに手で打った時だけ
export const STAFF_REASONS = [
  { key: "staff_only", label: "確認した事を入れた", hint: "管理会社・募集状況・金額・日程など（AIX の番）" },
  { key: "material", label: "会話・資料にある事が抜けていた", hint: "AI に材料が届いていない" },
  { key: "scene", label: "場面・決まりが違う", hint: "AI の読み違い" },
  { key: "wording", label: "言い回しだけ", hint: "中身は同じ" },
] as const;
export type StaffReasonKey = (typeof STAFF_REASONS)[number]["key"];
export const isStaffReasonKey = (v: string): v is StaffReasonKey => STAFF_REASONS.some((r) => r.key === v);

/** 理由を聞く番か: 下書きを直して送った・下書きがあったのに手で打った（下書きが無い・そのまま送った時は聞かない） */
export function shouldAskStaffReason(input: { outcome: string | null; originalDraft: string | null | undefined }): boolean {
  if (input.outcome === "draft_modified") return true;
  return input.outcome === "manual" && String(input.originalDraft ?? "").trim().length > 0;
}
export const staffReasonTapOn = (v: string | undefined = process.env.NEXT_PUBLIC_STAFF_REASON_TAP) => v === "on";
