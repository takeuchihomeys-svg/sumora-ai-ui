// app/lib/apply-status-aix.ts — 竹内さんの指摘 #13（勇気 10/27 23:09・10/28）の純関数とスイッチ
//
// 竹内さん「AIX で申込へを押したら、ここ（ステータス）を自動的に申込・審査中に変更する形とする。申込のステータスにすると AI文案生成ボタンを
//   押した時も文を作れないが、ここも出来るようにする。ボタンを押した時に限定して出来るようにする」
//
// ① AIX【申込へ】で申込の段に入る物（📄 フォーマット＝申込書を送る・✅ 申込確定・🔖 書類依頼）を送ったら status を applying（申込・審査中）に。
//    📋 申込誘導（後押しメッセージ）はまだお客様が決めていない段なので上げない。申込より前の段の時だけ上げる（成約・失注等は触らない）。
//    旧の自動昇格（applying-promotion.ts）は「お客様の意思（フォーム）が無い昇格は作らない」で AIX【申込へ】だけでは上げなかった＝竹内さんの今回の決定で変える
//    スイッチ: 画面 NEXT_PUBLIC_AIX_APPLY_STATUS=on（既定 off＝今と同じ）
// ② 申込・審査中でも、画面の「AI文案を作成」を手で押した時だけは下書きを作る（自動の下書き＝bg-async・cron は止めたまま）。
//    申込以降の個人情報の線（DeepSeek に渡さない・Claude だけ）は今まで通り。成約・失注・契約は今まで通り作らない
//    スイッチ: サーバ MANUAL_DRAFT_POST_APPLY=on（既定 off＝今と同じ）
import { PRE_APPLY_STATUSES } from "./application-form-detect";

/** 申込の段に入る AIX【申込へ】の選び（app_sub_mode） */
export const APPLY_AIX_SUB_MODES: ReadonlySet<string> = new Set(["format", "confirm", "docs_request"]);

export function aixApplyStatusOn(v: string | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "on";
}

/** AIX【申込へ】を送った後に status を applying に上げるか */
export function shouldPromoteOnApplyAix(subMode: string | null | undefined, status: string | null | undefined): boolean {
  if (!subMode || !APPLY_AIX_SUB_MODES.has(subMode)) return false;
  return !!status && (PRE_APPLY_STATUSES as readonly string[]).includes(status);
}

export function manualDraftPostApplyOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MANUAL_DRAFT_POST_APPLY ?? "").trim().toLowerCase() === "on";
}

/** 申込・審査中の段（手で押した時だけ下書きを作ってよい段）。契約・成約・失注は入れない */
export const APPLYING_FAMILY: ReadonlySet<string> = new Set(["applying", "application", "screening", "approved"]);

/**
 * 手で押した生成（caller=manual／manual_hint）を、申込以降の止めから外すか。
 *   state が申込・審査中の段、または申込より前（申込へ押下・本人確認書類で申込以降と判定された時）なら外す。契約・成約・失注は外さない
 */
export function manualDraftAllowedPostApply(o: { on: boolean; caller: string; state: string | null | undefined }): boolean {
  if (!o.on || (o.caller !== "manual" && o.caller !== "manual_hint")) return false;
  const s = o.state ?? "";
  return APPLYING_FAMILY.has(s) || !["contract", "closed_won", "closed_lost", "lost"].includes(s);
}
