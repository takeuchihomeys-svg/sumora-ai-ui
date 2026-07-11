"use client";

import { useEffect, useState } from "react";
import BottomNav from "../components/BottomNav";

type Task = {
  id: string;
  customer_name: string;
  status: string;
  desired_area: string;
  next_due_label: string;
  days_since_sent: number | null;
};

const STATUS_COLOR: Record<string, string> = {
  new_inquiry:     "bg-red-100 text-red-700",
  hot:             "bg-orange-100 text-orange-700",
  property_search: "bg-blue-100 text-blue-700",
};
const STATUS_EMOJI: Record<string, string> = {
  new_inquiry:     "🆕",
  hot:             "🔥",
  property_search: "🏠",
};
const STATUS_LABEL: Record<string, string> = {
  new_inquiry:     "新規",
  hot:             "毎日",
  property_search: "3日ごと",
};

export default function PropertyTasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [completing, setCompleting] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string>("");

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/property-tasks");
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const data = await res.json() as { ok: boolean; customers: Task[] };
      if (data.ok) setTasks(data.customers);
    } catch (e) {
      console.error("[fetchTasks] error:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTasks(); }, []);

  const handleComplete = async (task: Task) => {
    setCompleting(task.id);
    try {
      const res = await fetch("/api/property-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: task.id, action: "send" }),
      });
      if (!res.ok) throw new Error(`complete failed: ${res.status}`);
      setCompleted((prev) => new Set([...prev, task.id]));
    } catch (e) {
      console.error("[handleComplete] error:", e);
    } finally {
      setCompleting(null);
    }
  };

  const handleConfirm = async (task: Task) => {
    setCompleting(task.id);
    try {
      const res = await fetch("/api/property-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: task.id, action: "confirm" }),
      });
      if (!res.ok) throw new Error(`confirm failed: ${res.status}`);
      setCompleted((prev) => new Set([...prev, task.id]));
    } catch (e) {
      console.error("[handleConfirm] error:", e);
    } finally {
      setCompleting(null);
    }
  };

  const handleUpgradeAndComplete = async (task: Task) => {
    setCompleting(task.id);
    try {
      const res = await fetch("/api/property-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: task.id, upgrade_to_hot: true, action: "send" }),
      });
      if (!res.ok) throw new Error(`upgrade failed: ${res.status}`);
      setCompleted((prev) => new Set([...prev, task.id]));
    } catch (e) {
      console.error("[handleUpgradeAndComplete] error:", e);
    } finally {
      setCompleting(null);
    }
  };

  const handleSendToLine = async () => {
    setSending(true);
    setSendResult("");
    try {
      const res = await fetch("/api/send-property-list", {
        method: "POST",
        // 内部認証: NEXT_PUBLIC_INTERNAL_API_SECRET はサーバー側 INTERNAL_API_SECRET と同じ値を設定
        headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` },
      });
      if (!res.ok) throw new Error(`send failed: ${res.status}`);
      const data = await res.json() as { ok: boolean; count?: number; error?: string };
      setSendResult(data.ok ? `✅ ${data.count}名のリストをLINEに送信しました` : `❌ ${data.error}`);
    } catch (e) {
      console.error("[handleSendToLine] error:", e);
      setSendResult("❌ 送信に失敗しました。通信環境を確認してください");
    } finally {
      setSending(false);
    }
  };

  const visibleTasks = tasks.filter((t) => !completed.has(t.id));
  const today = new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });

  return (
    <main className="flex h-[calc(100svh-56px)] flex-col bg-[#f0f4f8]">
      {/* ヘッダー */}
      <header className="shrink-0 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]"
        style={{ background: "linear-gradient(135deg,#1a237e,#283593,#3949ab)" }}>
        <div className="flex items-center justify-between mb-1">
          <div>
            <div className="text-[18px] font-bold text-white">📋 物件出しタスク</div>
            <div className="text-[11px] text-white/70">{today}</div>
          </div>
          <button
            onClick={handleSendToLine}
            disabled={sending || visibleTasks.length === 0}
            className="flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-2 text-[12px] font-bold text-white disabled:opacity-50 active:bg-white/30"
          >
            {sending ? "送信中..." : "📲 LINEに送る"}
          </button>
        </div>
        {sendResult && (
          <div className="mt-1.5 rounded-xl bg-white/15 px-3 py-1.5 text-[11px] text-white">
            {sendResult}
          </div>
        )}
        {/* 件数バッジ */}
        <div className="mt-2 flex gap-2">
          {["new_inquiry", "hot", "property_search"].map((s) => {
            const count = visibleTasks.filter((t) => t.status === s).length;
            if (count === 0) return null;
            return (
              <div key={s} className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${STATUS_COLOR[s]}`}>
                {STATUS_EMOJI[s]} {STATUS_LABEL[s]} {count}名
              </div>
            );
          })}
        </div>
      </header>

      {/* リスト */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-[#8696a0]">読み込み中...</div>
        ) : visibleTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="text-4xl">🎉</div>
            <div className="text-[15px] font-bold text-[#111b21]">今日の物件出しは完了！</div>
            <div className="text-[12px] text-[#8696a0]">お疲れ様でした</div>
          </div>
        ) : (
          visibleTasks.map((task) => (
            <div key={task.id} className="rounded-2xl bg-white shadow-sm overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                {/* ステータスバッジ */}
                <div className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_COLOR[task.status]}`}>
                  {STATUS_EMOJI[task.status]} {STATUS_LABEL[task.status]}
                </div>
                {/* 顧客名・エリア */}
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-semibold text-[#111b21] truncate">
                    {task.customer_name} 様
                  </div>
                  {task.desired_area && (
                    <div className="text-[11px] text-[#8696a0] truncate">{task.desired_area}</div>
                  )}
                  <div className="text-[10px] text-[#b0bec5] mt-0.5">
                    {task.days_since_sent !== null ? `${task.days_since_sent}日前送信` : "未送信"}
                    　次回: {task.next_due_label}
                  </div>
                </div>
              </div>

              {/* アクションボタン */}
              <div className="flex border-t border-[#f0f2f5]">
                {/* 毎日に格上げ（property_searchのみ） */}
                {task.status === "property_search" && (
                  <button
                    onClick={() => handleUpgradeAndComplete(task)}
                    disabled={completing === task.id}
                    className="flex-1 py-2.5 text-[11px] font-bold text-orange-600 border-r border-[#f0f2f5] active:bg-orange-50 disabled:opacity-50"
                  >
                    🔥 毎日に変更して完了
                  </button>
                )}
                {/* 確認済み（🔥hotのみ・物件送らなくても本日対応完了） */}
                {task.status === "hot" && (
                  <button
                    onClick={() => handleConfirm(task)}
                    disabled={completing === task.id}
                    className="flex-1 py-2.5 text-[11px] font-bold text-sky-600 border-r border-[#f0f2f5] active:bg-sky-50 disabled:opacity-50"
                  >
                    👀 本日確認済み
                  </button>
                )}
                {/* 物件送信完了 */}
                <button
                  onClick={() => handleComplete(task)}
                  disabled={completing === task.id}
                  className="flex-1 py-2.5 text-[12px] font-bold text-emerald-600 active:bg-emerald-50 disabled:opacity-50"
                >
                  {completing === task.id ? "..." : "✅ 物件出し完了"}
                </button>
              </div>
            </div>
          ))
        )}

        {/* 完了済みカウント */}
        {completed.size > 0 && (
          <div className="text-center text-[11px] text-[#8696a0] py-2">
            ✅ {completed.size}名完了
          </div>
        )}
        <div className="h-4" />
      </div>

      <BottomNav />
    </main>
  );
}
