"use client";

import { useEffect, useState } from "react";
import BottomNav from "@/app/components/BottomNav";

type Status = "new_inquiry" | "hot" | "property_search" | "pending";

interface Customer {
  id: string;
  customer_name: string;
  line_user_id?: string;
  phone?: string;
  status: Status;
  assignee?: string;
  area?: string;
  max_rent?: number;
  layout?: string;
  preferences?: string;
  ng_points?: string;
  property_memo?: string;
  last_property_sent_at?: string;
  format_received?: boolean;
  move_in_time?: string;
  rent_min?: number;
  rent_max?: number;
  desired_area?: string;
  walk_minutes?: number;
  floor_plan?: string;
  initial_cost_limit?: number;
  building_age?: number;
  other_requests?: string;
  created_at: string;
  updated_at: string;
}

const STATUS_LABELS: Record<Status, string> = {
  new_inquiry: "新規問い合わせ",
  hot: "毎日物件出し",
  property_search: "物件出し",
  pending: "検討中",
};

const STATUS_COLORS: Record<Status, { bg: string; text: string; dot: string }> = {
  new_inquiry: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500" },
  hot: { bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-400" },
  property_search: { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-400" },
  pending: { bg: "bg-gray-50", text: "text-gray-500", dot: "bg-gray-300" },
};

const ALL_STATUSES: Status[] = ["new_inquiry", "hot", "property_search", "pending"];

function needsActionToday(c: Customer): boolean {
  if (c.status === "pending") return false;
  if (c.status === "new_inquiry") return true;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (c.status === "hot") {
    if (!c.last_property_sent_at) return true;
    return new Date(c.last_property_sent_at) < todayStart;
  }
  if (c.status === "property_search") {
    if (!c.last_property_sent_at) return true;
    const diff = (now.getTime() - new Date(c.last_property_sent_at).getTime()) / 86400000;
    return diff >= 3;
  }
  return false;
}

function daysSinceSent(c: Customer): number | null {
  if (!c.last_property_sent_at) return null;
  const diff = (Date.now() - new Date(c.last_property_sent_at).getTime()) / 86400000;
  return Math.floor(diff);
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<Status | "all">("all");
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
      if (!res.ok) return;
      const data = await res.json();
      setCustomers(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCustomers();
  }, []);

  const updateStatus = async (id: string, status: Status) => {
    setStatusUpdating(id);
    try {
      await fetch("/api/property-customers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      setCustomers((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
      setExpandedId(null);
    } finally {
      setStatusUpdating(null);
    }
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
      setCustomers((prev) =>
        prev.map((c) => (c.id === id ? { ...c, last_property_sent_at: now } : c))
      );
    } finally {
      setSentUpdating(null);
    }
  };

  const addCustomer = async () => {
    if (!newName.trim()) return;
    setAddLoading(true);
    try {
      const res = await fetch("/api/property-customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_name: newName.trim(),
          phone: newPhone.trim() || undefined,
          assignee: newAssignee.trim() || undefined,
          status: "new_inquiry",
        }),
      });
      if (res.ok) {
        const created = await res.json();
        setCustomers((prev) => [created, ...prev]);
        setNewName("");
        setNewPhone("");
        setNewAssignee("");
        setShowAddModal(false);
      }
    } finally {
      setAddLoading(false);
    }
  };

  const filtered = customers.filter(
    (c) => filterStatus === "all" || c.status === filterStatus
  );

  const todayCount = customers.filter((c) => needsActionToday(c)).length;

  const counts: Record<Status | "all", number> = {
    all: customers.length,
    new_inquiry: customers.filter((c) => c.status === "new_inquiry").length,
    hot: customers.filter((c) => c.status === "hot").length,
    property_search: customers.filter((c) => c.status === "property_search").length,
    pending: customers.filter((c) => c.status === "pending").length,
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <div
        className="sticky top-0 z-30 flex items-center justify-between px-4 py-3"
        style={{
          background: "white",
          borderBottom: "1px solid #e9edef",
          paddingTop: "max(env(safe-area-inset-top), 12px)",
        }}
      >
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-slate-800">お客さん管理</h1>
          {todayCount > 0 && (
            <span className="text-xs font-bold bg-red-500 text-white rounded-full px-2 py-0.5">
              今日{todayCount}件
            </span>
          )}
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-bold text-white"
          style={{ background: "#1565C0" }}
        >
          <span className="text-base leading-none">＋</span>
          <span>追加</span>
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex overflow-x-auto gap-2 px-4 py-2.5 bg-white border-b border-slate-100 scrollbar-hide">
        {(["all", ...ALL_STATUSES] as (Status | "all")[]).map((s) => {
          const isActive = filterStatus === s;
          const col = s === "all" ? null : STATUS_COLORS[s];
          return (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`flex-shrink-0 flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold border transition-all ${
                isActive
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-slate-200 bg-white text-slate-500"
              }`}
            >
              {col && (
                <span
                  className={`w-2 h-2 rounded-full ${isActive ? "bg-white" : col.dot}`}
                />
              )}
              {s === "all" ? "全員" : STATUS_LABELS[s]}
              <span
                className={`ml-0.5 ${
                  isActive ? "text-blue-100" : "text-slate-400"
                }`}
              >
                {counts[s]}
              </span>
            </button>
          );
        })}
      </div>

      {/* List */}
      <div className="flex-1 px-3 py-3 pb-28 space-y-2">
        {loading ? (
          <div className="text-center text-slate-400 py-16 text-sm">読み込み中...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-slate-400 py-16 text-sm">
            {filterStatus === "all" ? "まだお客さんがいません" : "該当なし"}
          </div>
        ) : (
          filtered.map((c) => {
            const col = STATUS_COLORS[c.status];
            const urgent = needsActionToday(c);
            const days = daysSinceSent(c);
            const isExpanded = expandedId === c.id;

            return (
              <div
                key={c.id}
                className={`bg-white rounded-xl border shadow-sm overflow-hidden ${
                  urgent ? "border-red-200" : "border-slate-100"
                }`}
              >
                {/* Main row */}
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : c.id)}
                >
                  {/* Urgent dot */}
                  <div
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      urgent ? "bg-red-500" : col.dot
                    }`}
                  />

                  {/* Name + info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-800 text-sm truncate">
                        {c.customer_name}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${col.bg} ${col.text}`}
                      >
                        {STATUS_LABELS[c.status]}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400">
                      {c.assignee && <span>担当: {c.assignee}</span>}
                      {c.desired_area && <span>📍{c.desired_area}</span>}
                      {c.rent_max && <span>〜{c.rent_max}万</span>}
                      {days !== null ? (
                        <span className={days >= 3 ? "text-red-400 font-bold" : ""}>
                          {days === 0 ? "今日送信済" : `${days}日前送信`}
                        </span>
                      ) : (
                        c.status !== "pending" && (
                          <span className="text-red-400 font-bold">未送信</span>
                        )
                      )}
                    </div>
                  </div>

                  {/* Chevron */}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#90caf9"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className={`flex-shrink-0 transition-transform duration-200 ${
                      isExpanded ? "rotate-180" : ""
                    }`}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>

                {/* Expanded panel */}
                {isExpanded && (
                  <div className="border-t border-slate-100 px-4 py-3 space-y-3">
                    {/* Info grid */}
                    {(c.preferences || c.ng_points || c.property_memo || c.other_requests) && (
                      <div className="space-y-1.5 text-xs text-slate-600">
                        {c.preferences && (
                          <div>
                            <span className="text-slate-400 font-medium">こだわり: </span>
                            {c.preferences}
                          </div>
                        )}
                        {c.ng_points && (
                          <div>
                            <span className="text-slate-400 font-medium">NG: </span>
                            {c.ng_points}
                          </div>
                        )}
                        {c.property_memo && (
                          <div>
                            <span className="text-slate-400 font-medium">メモ: </span>
                            {c.property_memo}
                          </div>
                        )}
                        {c.other_requests && (
                          <div>
                            <span className="text-slate-400 font-medium">その他: </span>
                            {c.other_requests}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Quick actions */}
                    <div className="flex flex-wrap gap-2">
                      {/* Mark sent */}
                      {c.status !== "pending" && (
                        <button
                          onClick={() => markPropertySent(c.id)}
                          disabled={sentUpdating === c.id}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 disabled:opacity-50"
                        >
                          {sentUpdating === c.id ? "..." : "✓ 物件送った"}
                        </button>
                      )}

                      {/* Status change */}
                      {ALL_STATUSES.filter((s) => s !== c.status).map((s) => (
                        <button
                          key={s}
                          onClick={() => updateStatus(c.id, s)}
                          disabled={statusUpdating === c.id}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold border disabled:opacity-50 ${STATUS_COLORS[s].bg} ${STATUS_COLORS[s].text} border-current`}
                        >
                          {statusUpdating === c.id ? "..." : `→ ${STATUS_LABELS[s]}`}
                        </button>
                      ))}
                    </div>

                    {/* Contact */}
                    {c.phone && (
                      <a
                        href={`tel:${c.phone}`}
                        className="flex items-center gap-1.5 text-xs text-blue-600 font-medium"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.5 19.79 19.79 0 0 1 1.61 4.87 2 2 0 0 1 3.58 2.68h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 10a16 16 0 0 0 6.29 6.29l1.42-1.42a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                        </svg>
                        {c.phone}
                      </a>
                    )}
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
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={(e) => e.target === e.currentTarget && setShowAddModal(false)}
        >
          <div className="w-full bg-white rounded-t-2xl px-5 py-5 space-y-4"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 20px)" }}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-slate-800 text-base">お客さん追加</h2>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 text-xl leading-none">✕</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">お客さん名 *</label>
                <input
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-blue-400"
                  placeholder="例: 田中さん"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">電話番号</label>
                <input
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-blue-400"
                  placeholder="例: 090-1234-5678"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  type="tel"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">担当者</label>
                <input
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-blue-400"
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
              style={{ background: "#1565C0" }}
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
