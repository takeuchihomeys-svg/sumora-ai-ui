"use client";
// app/components/PickupEstimateButton.tsx
// AIX ツール（売上サポ＝PickupReview）の物件の札の「🧾 見積書作成」。押すと見積書作成（/estimate?conv=…&pickup=<行の id>）を
// その行のお部屋で開く（資料の画像・PDF の文字・家賃・管理費・AD・お客様名・アカウントは見積書の画面がサーバーから読む＝URL は id だけ）。
//
// 2026-10-06 竹内「AIXツール 物件ごとに見積書作成のボタンをつける それを押すと見積書と連携して作成できるようにする」
//   中身の受け渡しは既存の LINE → 見積書の引き継ぎ（estimate-handoff・2026-10-01）にそのまま乗せた（作り直さない）。
//   ⚠ 画面の部品なのでサーバー専用ライブラリを import しない（estimate-handoff は純関数）
import { buildEstimateHref } from "@/app/lib/estimate-handoff";

export default function PickupEstimateButton({ conversationId, pickupId, onGo }: {
  conversationId: string | null;
  pickupId: number;
  /** 別のページへ移る（PickupReview の leaveTo＝スマホで積んだ履歴を置き換える） */
  onGo: (href: string) => void;
}) {
  const disabled = !conversationId;
  return (
    <button type="button" disabled={disabled}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (conversationId) onGo(buildEstimateHref(conversationId, "estimate", { pickupId })); }}
      title={disabled
        ? "このお客様は LINE の会話に紐付いていません（お客さん画面で紐付けてから）"
        : "このお部屋で見積書作成を開く（資料の画像・文字・家賃・管理費・AD・お客様名をセットし、AI 読み取りまで進める。割引と最終確認はスタッフ。作ったら AIX【見積書送る】にセットして LINE へ）"}
      className="shrink-0 rounded-full px-2.5 py-1 font-bold leading-none"
      style={{ background: "#e8f5e9", color: "#2e7d32", opacity: disabled ? 0.4 : 1, fontSize: 11 /* globals.css の button { font: inherit } が text-[11px] に勝つため */ }}>
      🧾 見積書作成
    </button>
  );
}
