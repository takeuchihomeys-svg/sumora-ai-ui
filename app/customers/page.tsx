"use client";

import { useEffect, useState, useMemo } from "react";
import BottomNav from "@/app/components/BottomNav";

type LinkedConversation = {
  id: string;
  last_message?: string | null;
  last_sender?: string | null;
  updated_at?: string | null;
  account?: string | null;
  status?: string | null;
};

type Customer = {
  id: string;
  customer_name: string;
  line_user_id?: string | null;
  phone?: string | null;
  status: string;
  account?: string | null;
  assignee?: string | null;
  preferences?: string | null;
  ng_points?: string | null;
  property_memo?: string | null;
  last_property_sent_at?: string | null;
  move_in_time?: string | null;
  rent_min?: number | null;
  rent_max?: number | null;
  desired_area?: string | null;
  walk_minutes?: number | null;
  floor_plan?: string | null;
  building_age?: number | null;
  other_requests?: string | null;
  created_at: string;
  updated_at: string;
  is_linked?: boolean;
  linked_conversation?: LinkedConversation | null;
};

const PROPERTY_STATUS: Record<string, { label: string; color: string }> = {
  new_inquiry:     { label: "新規",    color: "bg-red-100 text-red-700" },
  hot:             { label: "毎日",    color: "bg-orange-100 text-orange-700" },
  property_search: { label: "物件出し", color: "bg-blue-100 text-blue-700" },
  pending:         { label: "検討中",  color: "bg-gray-100 text-gray-500" },
};

const ACCOUNT_LABEL: Record<string, string> = {
  sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ", hasu: "ハス",
};

function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

function needsPropertyAction(status: string, lastSentAt?: string | null): boolean {
  if (status === "pending") return false;
  if (status === "new_inquiry") return true;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (status === "hot") return !lastSentAt || new Date(lastSentAt) < todayStart;
  if (status === "property_search") {
    if (!lastSentAt) return true;
    return (now.getTime() - new Date(lastSentAt).getTime()) / 86400000 >= 3;
  }
  return false;
}

function daysSinceSent(lastSentAt?: string | null): number | null {
  if (!lastSentAt) return null;
  return Math.floor((Date.now() - new Date(lastSentAt).getTime()) / 86400000);
}

type UrgencyLevel = "reply" | "property" | "ok" | "passive";

function getUrgency(c: Customer): UrgencyLevel {
  const needsReply = c.linked_conversation?.last_sender === "customer";
  if (needsReply) return "reply";
  if (needsPropertyAction(c.status, c.last_property_sent_at)) return "property";
  if (c.status === "pending") return "passive";
  return "ok";
}

const URGENCY_ORDER: Record<UrgencyLevel, number> = { reply: 0, property: 1, ok: 2, passive: 3 };

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterLinked, setFilterLinked] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusUpdating, setStatusUpdating] = useState<string | null>(null);
  const [sentUpdating, setSentUpdating] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  const fetchCustomers = async () => {
    try {
      const res = await fetch("/api/property-customers");
      if (res.ok) setCustomers(await res.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchCustomers(); }, []);

  const sorted = useMemo(() => {
    const base = filterLinked ? customers.filter((c) => c.is_linked) : customers;
    return [...base].sort((a, b) => URGENCY_ORDER[getUrgency(a)] - URGENCY_ORDER[getUrgency(b)]);
  }, [customers, filterLinked]);

  const linkedCount = customers.filter((c) => c.is_linked).length;
  const replyCount = customers.filter((c) => getUrgency(c) === "reply").length;

  const updateStatus = async (id: string, status: string) => {
    setStatusUpdating(id);
    try {
      await fetch("/api/property-customers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      setCustomers((prev) => prev.map((c) => c.id === id ? { ...c, status } : c));
      setExpandedId(null);
    } finally { setStatusUpdating(null); }
  };

  const markPropertySent = async (id: string) => {
    setSentUpdating(id);
    try {
      const now = new Date().toISOString();
      await fetch("/api/property-customers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, last_property_sent_at: now }),
      });
      setCustomers((prev) => prev.map((c) => c.id === id ? { ...c, last_property_sent_at: now } : c));
    } finally { setSentUpdating(null); }
  };

  const addCustomer = async () => {
    if (!newName.trim()) return;
    setAddLoading(true);
    try {
      const res = await fetch("/api/property-customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_name: newName.trim(), phone: newPhone.trim() || undefined, assignee: newAssignee.trim() || undefined, status: "new_inquiry" }),
      });
      if (res.ok) {
        const created = await res.json();
        setCustomers((prev) => [created, ...prev]);
        setNewName(""); setNewPhone(""); setNewAssignee("");
        setShowAddModal(false);
      }
    } finally { setAddLoading(false); }
  };

  return (
    <div className="bg-[#f0f2f5] flex flex-col" style={{ height: "100svh", overflowY: "auto" }}>
      {/* Header */}
      <div
        className="sticky top-0 z-30 px-4 pb-3"
        style={{
          background: "linear-gradient(135deg, #0d1b3e, #1565C0)",
          paddingTop: "max(env(safe-area-inset-top), 14px)",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h1 className="text-[17px] font-black text-white tracking-tight">お客さん</h1>
            {replyCount > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white">
                <span>⏰</span>{replyCount}人 未返信
              </span>
            )}
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-sm font-bold text-white border border-white/30"
            style={{ background: "rgba(255,255,255,0.15)" }}
          >
            <span className="text-base leading-none">＋</span>
            <span>追加</span>
          </button>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2">
          <button
            onClick={() => setFilterLinked(true)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all ${filterLinked ? "bg-white text-[#1565C0]" : "bg-white/10 text-white/70 border border-white/20"}`}
          >
            🔗 紐付け済
            <span className={`text-[10px] ${filterLinked ? "text-[#1565C0]/60" : "text-white/40"}`}>{linkedCount}</span>
          </button>
          <button
            onClick={() => setFilterLinked(false)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all ${!filterLinked ? "bg-white text-[#1565C0]" : "bg-white/10 text-white/70 border border-white/20"}`}
          >
            全員
            <span className={`text-[10px] ${!filterLinked ? "text-[#1565C0]/60" : "text-white/40"}`}>{customers.length}</span>
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 px-3 py-3 pb-28 space-y-2.5">
        {loading ? (
          <div className="text-center text-[#667781] py-16 text-sm">読み込み中...</div>
        ) : sorted.length === 0 ? (
          <div className="text-center text-[#667781] py-16 text-sm">
            {filterLinked ? "紐付き済みのお客さんがいません" : "お客さんがいません"}
          </div>
        ) : (
          sorted.map((c) => {
            const urgency = getUrgency(c);
            const conv = c.linked_conversation;
            const needsReply = urgency === "reply";
            const needsProp = urgency === "property";
            const propDays = daysSinceSent(c.last_property_sent_at);
            const propStatus = PROPERTY_STATUS[c.status] ?? { label: c.status, color: "bg-gray-100 text-gray-500" };
            const isExpanded = expandedId === c.id;

            const borderColor = needsReply ? "#ef4444" : needsProp ? "#f97316" : "#e9edef";
            const headerBg = needsReply
              ? "linear-gradient(135deg, #fee2e2, #fff7f7)"
              : needsProp
              ? "linear-gradient(135deg, #fff7ed, #fffcf9)"
              : "linear-gradient(135deg, #f8faff, #ffffff)";

            return (
              <div
                key={c.id}
                className="rounded-2xl overflow-hidden shadow-sm"
                style={{ border: `1.5px solid ${borderColor}`, background: "white" }}
              >
                {/* Card header */}
                <button
                  className="w-full text-left px-4 pt-3.5 pb-3"
                  style={{ background: headerBg }}
                  onClick={() => setExpandedId(isExpanded ? null : c.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      {/* Name + badges */}
                      <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        {c.is_linked && (
                          <span className="shrink-0 text-[11px] text-emerald-600 font-bold">🔗</span>
                        )}
                        <span className="text-[15px] font-bold text-[#111b21] truncate">
                          {c.customer_name}
                        </span>
                        {conv?.account && (
                          <span className="shrink-0 rounded-full bg-[#e9edef] px-1.5 py-0.5 text-[9px] font-bold text-[#667781]">
                            {ACCOUNT_LABEL[conv.account] ?? conv.account}
                          </span>
                        )}
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${propStatus.color}`}>
                          {propStatus.label}
                        </span>
                        {c.assignee && (
                          <span className="shrink-0 rounded-full bg-blue-50 px-1.5 py-0.5 text-[9px] font-bold text-blue-600">
                            {c.assignee}
                          </span>
                        )}
                      </div>

                      {/* LINE status + property status */}
                      <div className="flex items-center gap-3 text-[11px]">
                        {conv ? (
                          <span className={`flex items-center gap-1 font-bold ${needsReply ? "text-red-500" : "text-[#8696a0]"}`}>
                            {needsReply ? "⏰" : "✅"}
                            {needsReply ? "未返信" : "返信済"}
                            {conv.updated_at && (
                              <span className="font-normal text-[#aaa]">{relativeTime(conv.updated_at)}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-[#bbb]">LINE未紐付け</span>
                        )}
                        <span className={`font-medium ${needsProp ? "text-orange-500 font-bold" : "text-[#8696a0]"}`}>
                          {propDays === null
                            ? (c.status !== "pending" ? "📦 未送信" : "")
                            : propDays === 0
                            ? "📦 今日送信済"
                            : `📦 ${propDays}日前`}
                        </span>
                      </div>
                    </div>

                    {/* Chevron */}
                    <svg
                      width="16" height="16" viewBox="0 0 24 24" fill="none"
                      stroke="#90caf9" strokeWidth="2" strokeLinecap="round"
                      className={`shrink-0 mt-1 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </button>

                {/* Property conditions */}
                <div className="px-4 py-2.5 border-t border-[#f0f2f5]">
                  <div className="flex flex-wrap gap-1.5">
                    {c.desired_area && (
                      <span className="flex items-center gap-0.5 rounded-full bg-[#e3f2fd] px-2 py-0.5 text-[11px] font-medium text-[#1565C0]">
                        📍 {c.desired_area}
                      </span>
                    )}
                    {c.floor_plan && (
                      <span className="flex items-center gap-0.5 rounded-full bg-[#e8f5e9] px-2 py-0.5 text-[11px] font-medium text-[#2e7d32]">
                        🏠 {c.floor_plan}
                      </span>
                    )}
                    {(c.rent_min || c.rent_max) && (
                      <span className="flex items-center gap-0.5 rounded-full bg-[#fff3e0] px-2 py-0.5 text-[11px] font-medium text-[#e65100]">
                        💰{" "}
                        {c.rent_min ? `${Math.floor(c.rent_min / 10000)}万〜` : ""}
                        {c.rent_max ? `${Math.floor(c.rent_max / 10000)}万` : ""}
                      </span>
                    )}
                    {c.walk_minutes && (
                      <span className="flex items-center gap-0.5 rounded-full bg-[#f3e5f5] px-2 py-0.5 text-[11px] font-medium text-[#6a1b9a]">
                        🚶 {c.walk_minutes}分以内
                      </span>
                    )}
                    {c.move_in_time && (
                      <span className="flex items-center gap-0.5 rounded-full bg-[#e0f7fa] px-2 py-0.5 text-[11px] font-medium text-[#006064]">
                        📅 {c.move_in_time}
                      </span>
                    )}
                    {c.building_age && (
                      <span className="flex items-center gap-0.5 rounded-full bg-[#fce4ec] px-2 py-0.5 text-[11px] font-medium text-[#880e4f]">
                        🏢 {c.building_age}年以内
                      </span>
                    )}
                  </div>
                  {(c.preferences || c.ng_points) && (
                    <div className="mt-1.5 space-y-0.5">
                      {c.preferences && (
                        <p className="text-[11px] text-[#667781]">
                          <span className="text-[#2196F3] font-bold">✨</span> {c.preferences}
                        </p>
                      )}
                      {c.ng_points && (
                        <p className="text-[11px] text-[#667781]">
                          <span className="text-red-400 font-bold">❌</span> {c.ng_points}
                        </p>
                      )}
                    </div>
                  )}
                  {(!c.desired_area && !c.floor_plan && !c.rent_min && !c.rent_max && !c.preferences && !c.ng_points) && (
                    <p className="text-[11px] text-[#bbb]">条件未入力</p>
                  )}
                </div>

                {/* Quick actions */}
                <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[#f0f2f5] bg-[#fafafa]">
                  {c.status !== "pending" && (
                    <button
                      onClick={() => markPropertySent(c.id)}
                      disabled={sentUpdating === c.id}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 active:scale-95 transition-transform disabled:opacity-50"
                    >
                      {sentUpdating === c.id ? "..." : "✓ 物件送った"}
                    </button>
                  )}
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 active:scale-95 transition-transform"
                    >
                      📞
                    </a>
                  )}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : c.id)}
                    className="ml-auto text-[11px] text-[#8696a0] flex items-center gap-0.5"
                  >
                    {isExpanded ? "閉じる ▲" : "詳細 ▼"}
                  </button>
                </div>

                {/* Expanded: status change + memo */}
                {isExpanded && (
                  <div className="px-4 py-3 border-t border-[#f0f2f5] space-y-2">
                    {(c.property_memo || c.other_requests) && (
                      <div className="space-y-1 text-[11px] text-[#667781]">
                        {c.property_memo && <p><span className="font-bold text-[#8696a0]">メモ: </span>{c.property_memo}</p>}
                        {c.other_requests && <p><span className="font-bold text-[#8696a0]">その他: </span>{c.other_requests}</p>}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {["new_inquiry", "hot", "property_search", "pending"]
                        .filter((s) => s !== c.status)
                        .map((s) => {
                          const meta = PROPERTY_STATUS[s];
                          return (
                            <button
                              key={s}
                              onClick={() => updateStatus(c.id, s)}
                              disabled={statusUpdating === c.id}
                              className={`px-3 py-1.5 rounded-xl text-xs font-bold border active:scale-95 transition-transform disabled:opacity-50 ${meta.color} border-current`}
                            >
                              {statusUpdating === c.id ? "..." : `→ ${meta.label}`}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Add modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => e.target === e.currentTarget && setShowAddModal(false)}
        >
          <div
            className="w-full bg-white rounded-t-2xl px-5 py-5 space-y-4"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 20px)" }}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-[#111b21] text-base">お客さん追加</h2>
              <button onClick={() => setShowAddModal(false)} className="text-[#aaa] text-xl leading-none">✕</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-[#8696a0] mb-1 block">お客さん名 *</label>
                <input
                  className="w-full border border-[#e9edef] rounded-xl px-3 py-2.5 text-sm text-[#111b21] focus:outline-none focus:border-[#2196F3]"
                  placeholder="例: 田中さん"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[#8696a0] mb-1 block">電話番号</label>
                <input
                  className="w-full border border-[#e9edef] rounded-xl px-3 py-2.5 text-sm text-[#111b21] focus:outline-none focus:border-[#2196F3]"
                  placeholder="090-1234-5678"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  type="tel"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[#8696a0] mb-1 block">担当者</label>
                <input
                  className="w-full border border-[#e9edef] rounded-xl px-3 py-2.5 text-sm text-[#111b21] focus:outline-none focus:border-[#2196F3]"
                  placeholder="例: 竹内"
                  value={newAssignee}
                  onChange={(e) => setNewAssignee(e.target.value)}
                />
              </div>
            </div>
            <button
              onClick={addCustomer}
              disabled={!newName.trim() || addLoading}
              className="w-full py-3 rounded-xl font-bold text-white text-sm disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}
            >
              {addLoading ? "追加中..." : "追加する"}
            </button>
          </div>
        </div>
      )}

      <BottomNav />
    </div>
  );
}
