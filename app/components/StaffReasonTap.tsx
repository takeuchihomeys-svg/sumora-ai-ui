"use client";
// app/components/StaffReasonTap.tsx — スタッフの理由のワンタップ（app/lib/staff-reason.ts）
//   送った直後に入力欄の上に1行で出す。押すと /api/staff-reason（サーバーの鍵）が brain_decision_logs.staff_reason に書いて消える。
//   20秒で自動で消える（押さなくてよい）。画面の公開キーでは書かない
import { useEffect } from "react";
import { STAFF_REASONS, type StaffReasonKey } from "../lib/staff-reason";

export default function StaffReasonTap({ ask, onDone }: { ask: { logId: string } | null; onDone: () => void }) {
  useEffect(() => {
    if (!ask) return;
    const t = setTimeout(onDone, 20_000);
    return () => clearTimeout(t);
  }, [ask, onDone]);
  if (!ask) return null;
  const pick = (key: StaffReasonKey) => {
    const logId = ask.logId;
    onDone();
    void fetch("/api/staff-reason", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ logId, reason: key }) })
      .then((r) => { if (!r.ok) console.warn("[StaffReasonTap] 書けない:", r.status); })
      .catch((e) => console.warn("[StaffReasonTap] 書けない:", e));
  };
  return (
    <div className="mb-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-700">
      <div className="mb-1 flex items-center justify-between">
        <span>AI の下書きと違う理由（任意）</span>
        <button onClick={onDone} className="ml-3 shrink-0 font-bold text-slate-500 active:opacity-60">閉じる</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {STAFF_REASONS.map((r) => (
          <button key={r.key} onClick={() => pick(r.key)} title={r.hint} className="rounded-full border border-slate-300 bg-white px-2.5 py-1 active:bg-slate-100">{r.label}</button>
        ))}
      </div>
    </div>
  );
}
