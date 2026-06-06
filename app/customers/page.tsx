"use client";

import { useEffect, useState, useMemo } from "react";
import BottomNav from "@/app/components/BottomNav";

type LinkedConv = {
  id: string;
  last_message?: string | null;
  last_sender?: string | null;
  updated_at?: string | null;
  account?: string | null;
  status?: string | null;
  profile_image_url?: string | null;
  customer_name?: string | null;
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
  initial_cost_limit?: number | null;
  floor_area_min?: number | null;
  property_send_count?: number | null;
  property_viewed_at?: string | null;
  additional_conditions?: string | null;
  created_at: string;
  updated_at: string;
  is_linked?: boolean;
  linked_conversation?: LinkedConv | null;
};

const PROP_STATUS: Record<string, { label: string; dot: string }> = {
  new_inquiry:     { label: "新規",    dot: "bg-red-500" },
  hot:             { label: "毎日",    dot: "bg-orange-400" },
  property_search: { label: "物件出し", dot: "bg-blue-400" },
  pending:         { label: "検討中",  dot: "bg-gray-300" },
};

const ACCT_LABEL: Record<string, string> = {
  sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ", hasu: "ハス",
};

function relTime(d?: string | null) {
  if (!d) return "";
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

function needsProp(status: string, lastSent?: string | null) {
  if (status === "pending") return false;
  if (status === "new_inquiry") return true;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (status === "hot") return !lastSent || new Date(lastSent) < today;
  if (status === "property_search") {
    if (!lastSent) return true;
    return (Date.now() - new Date(lastSent).getTime()) / 86400000 >= 3;
  }
  return false;
}

type Urgency = "reply" | "property" | "ok" | "passive";
function urgency(c: Customer): Urgency {
  if (c.linked_conversation?.last_sender === "customer") return "reply";
  if (needsProp(c.status, c.last_property_sent_at)) return "property";
  if (c.status === "pending") return "passive";
  return "ok";
}
const URGENCY_ORDER: Record<Urgency, number> = { reply: 0, property: 1, ok: 2, passive: 3 };

function initial(name: string) { return name?.trim()?.charAt(0) ?? "?"; }

function isToday(d?: string | null): boolean {
  if (!d) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return new Date(d) >= today;
}

function completedToday(c: Customer): { sent: boolean; viewed: boolean } {
  return { sent: isToday(c.last_property_sent_at), viewed: isToday(c.property_viewed_at) };
}

function isDoneToday(c: Customer): boolean {
  const { sent, viewed } = completedToday(c);
  return sent || viewed;
}

type EditFields = {
  desired_area: string; floor_plan: string;
  rent_min: string; rent_max: string;
  walk_minutes: string; move_in_time: string;
  building_age: string; initial_cost_limit: string;
  floor_area_min: string;
  preferences: string; ng_points: string;
  other_requests: string; property_memo: string;
};

function toEditFields(c: Customer): EditFields {
  return {
    desired_area:       c.desired_area       ?? "",
    floor_plan:         c.floor_plan         ?? "",
    rent_min:           c.rent_min           ? String(Math.floor(c.rent_min / 10000)) : "",
    rent_max:           c.rent_max           ? String(Math.floor(c.rent_max / 10000)) : "",
    walk_minutes:       c.walk_minutes       ? String(c.walk_minutes) : "",
    move_in_time:       c.move_in_time       ?? "",
    building_age:       c.building_age       ? String(c.building_age) : "",
    initial_cost_limit: c.initial_cost_limit ? String(Math.floor(c.initial_cost_limit / 10000)) : "",
    floor_area_min:     c.floor_area_min     ? String(c.floor_area_min) : "",
    preferences:        c.preferences        ?? "",
    ng_points:          c.ng_points          ?? "",
    other_requests:     c.other_requests     ?? "",
    property_memo:      c.property_memo      ?? "",
  };
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filterLinked, setFilterLinked] = useState(true);
  const [expandedId, setExpandedId]     = useState<string | null>(null);
  const [sentUpdating, setSentUpdating]   = useState<string | null>(null);
  const [viewedUpdating, setViewedUpdating] = useState<string | null>(null);
  const [showCompleted, setShowCompleted]   = useState(true);

  const [showAdd, setShowAdd]       = useState(false);
  const [newName, setNewName]       = useState("");
  const [newPhone, setNewPhone]     = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  const [editId, setEditId]         = useState<string | null>(null);
  const [editFields, setEditFields] = useState<EditFields | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const fetchCustomers = async () => {
    const res = await fetch("/api/property-customers");
    if (res.ok) setCustomers(await res.json());
    setLoading(false);
  };
  useEffect(() => { fetchCustomers(); }, []);

  const base = useMemo(() =>
    filterLinked ? customers.filter((c) => c.is_linked) : customers,
  [customers, filterLinked]);

  const completedList = useMemo(() =>
    base.filter((c) => isDoneToday(c)),
  [base]);

  const sorted = useMemo(() =>
    base.filter((c) => !isDoneToday(c))
      .sort((a, b) => URGENCY_ORDER[urgency(a)] - URGENCY_ORDER[urgency(b)]),
  [base]);

  const linkedCount = customers.filter((c) => c.is_linked).length;
  const replyCount  = customers.filter((c) => urgency(c) === "reply").length;

  const markSent = async (id: string) => {
    setSentUpdating(id);
    const now = new Date().toISOString();
    const res = await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, last_property_sent_at: now }),
    });
    if (res.ok) {
      const updated = await res.json();
      // APIで自動昇格した status も含めて反映
      setCustomers((p) => p.map((c) => c.id === id ? { ...c, ...updated } : c));
    } else {
      setCustomers((p) => p.map((c) => c.id === id ? { ...c, last_property_sent_at: now } : c));
    }
    setSentUpdating(null);
  };

  const addCustomer = async () => {
    if (!newName.trim() || addLoading) return;
    setAddLoading(true);
    const res = await fetch("/api/property-customers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_name: newName.trim(), phone: newPhone.trim() || undefined, assignee: newAssignee.trim() || undefined, status: "new_inquiry" }),
    });
    if (res.ok) {
      const created = await res.json();
      setCustomers((p) => [created, ...p]);
      setNewName(""); setNewPhone(""); setNewAssignee(""); setShowAdd(false);
    }
    setAddLoading(false);
  };

  const clearAdditional = async (id: string) => {
    await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, additional_conditions: null }),
    });
    setCustomers((p) => p.map((c) => c.id === id ? { ...c, additional_conditions: null } : c));
  };

  const markViewed = async (id: string) => {
    setViewedUpdating(id);
    const now = new Date().toISOString();
    const res = await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, property_viewed_at: now, property_send_count: 0 }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCustomers((p) => p.map((c) => c.id === id ? { ...c, ...updated } : c));
    }
    setViewedUpdating(null);
  };

  const openEdit = (c: Customer) => { setEditId(c.id); setEditFields(toEditFields(c)); };

  const saveEdit = async () => {
    if (!editId || !editFields || editSaving) return;
    setEditSaving(true);
    const patch = {
      id: editId,
      desired_area:       editFields.desired_area       || null,
      floor_plan:         editFields.floor_plan         || null,
      rent_min:           editFields.rent_min           ? Number(editFields.rent_min) * 10000           : null,
      rent_max:           editFields.rent_max           ? Number(editFields.rent_max) * 10000           : null,
      walk_minutes:       editFields.walk_minutes       ? Number(editFields.walk_minutes)               : null,
      move_in_time:       editFields.move_in_time       || null,
      building_age:       editFields.building_age       ? Number(editFields.building_age)               : null,
      initial_cost_limit: editFields.initial_cost_limit ? Number(editFields.initial_cost_limit) * 10000 : null,
      floor_area_min:     editFields.floor_area_min     ? Number(editFields.floor_area_min)              : null,
      preferences:        editFields.preferences        || null,
      ng_points:          editFields.ng_points          || null,
      other_requests:     editFields.other_requests     || null,
      property_memo:      editFields.property_memo      || null,
    };
    const res = await fetch("/api/property-customers", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const updated = await res.json();
      setCustomers((p) => p.map((c) => c.id === editId ? { ...c, ...updated } : c));
    }
    setEditId(null); setEditFields(null); setEditSaving(false);
  };

  return (
    <div className="flex flex-col" style={{ height: "100svh", background: "#f0f2f5", overflowY: "auto" }}>

      {/* ── Header ── */}
      <div
        className="sticky top-0 z-30 px-4 pb-3"
        style={{ background: "linear-gradient(135deg, #0d1b3e 0%, #1565C0 100%)", paddingTop: "max(env(safe-area-inset-top), 14px)" }}
      >
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[18px] font-black text-white tracking-tight">お客さん</span>
            {replyCount > 0 && (
              <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
                未返信 {replyCount}件
              </span>
            )}
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-xl border border-white/30 px-3 py-1.5 text-xs font-bold text-white active:opacity-70"
            style={{ background: "rgba(255,255,255,0.13)" }}
          >
            ＋ 追加
          </button>
        </div>
        <div className="flex gap-2">
          {([true, false] as const).map((linked) => (
            <button
              key={String(linked)}
              onClick={() => setFilterLinked(linked)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${filterLinked === linked ? "bg-white text-[#1565C0]" : "border border-white/25 text-white/70"}`}
            >
              {linked ? `紐付き ${linkedCount}` : `全員 ${customers.length}`}
            </button>
          ))}
        </div>
      </div>

      {/* ── 完了セクション ── */}
      {!loading && completedList.length > 0 && (
        <div className="mx-3 mt-2.5">
          <button
            onClick={() => setShowCompleted((v) => !v)}
            className="flex w-full items-center justify-between rounded-2xl border border-[#e9edef] bg-white px-4 py-2.5 shadow-sm active:bg-[#f5f6f6]"
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold text-[#111b21]">完了</span>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                {completedList.length}件
              </span>
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#90caf9" strokeWidth="2" strokeLinecap="round"
              className={`transition-transform duration-200 ${showCompleted ? "rotate-180" : ""}`}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {showCompleted && (
            <div className="mt-1 space-y-1">
              {completedList.map((c) => {
                const conv = c.linked_conversation;
                const { sent, viewed } = completedToday(c);
                return (
                  <div key={c.id}
                    className="flex items-center gap-3 rounded-2xl border border-[#e9edef] bg-white px-4 py-2.5">
                    {/* アイコン */}
                    <div className="shrink-0">
                      {conv?.profile_image_url ? (
                        <img src={conv.profile_image_url} alt={c.customer_name}
                          className="h-9 w-9 rounded-full object-cover" />
                      ) : (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#d9fdd3] text-sm font-bold text-[#0f8f44]">
                          {initial(c.customer_name)}
                        </div>
                      )}
                    </div>
                    {/* 名前 */}
                    <span className="flex-1 truncate text-[13px] font-semibold text-[#111b21]">
                      {c.customer_name}
                    </span>
                    {/* バッジ */}
                    <div className="flex shrink-0 gap-1.5">
                      {sent && (
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                          物件送った
                        </span>
                      )}
                      {viewed && (
                        <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                          物件確認済
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── List ── */}
      <div className="flex-1 pb-28">
        {loading ? (
          <div className="py-16 text-center text-sm text-[#667781]">読み込み中...</div>
        ) : sorted.length === 0 ? (
          <div className="py-16 text-center text-sm text-[#667781]">
            {filterLinked ? "紐付き済みのお客さんがいません" : "お客さんがいません"}
          </div>
        ) : (
          sorted.map((c) => {
            const u        = urgency(c);
            const conv     = c.linked_conversation;
            const propMeta = PROP_STATUS[c.status] ?? { label: c.status, dot: "bg-gray-300" };
            const isExp    = expandedId === c.id;
            const days     = c.last_property_sent_at
              ? Math.floor((Date.now() - new Date(c.last_property_sent_at).getTime()) / 86400000)
              : null;

            const borderColor = u === "reply" ? "#ef4444" : u === "property" ? "#f97316" : "#e9edef";

            return (
              <div key={c.id} className="mx-3 mt-2.5 rounded-2xl overflow-hidden shadow-sm"
                style={{ border: `1.5px solid ${borderColor}`, background: "#fff" }}>

                {/* ── ヘッダー行 ── */}
                <button
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-[#f5f6f6]"
                  onClick={() => setExpandedId(isExp ? null : c.id)}
                >
                  {/* プロフィール画像 */}
                  <div className="relative shrink-0">
                    {conv?.profile_image_url ? (
                      <img src={conv.profile_image_url} alt={c.customer_name}
                        className="h-12 w-12 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#d9fdd3] text-base font-bold text-[#0f8f44]">
                        {initial(c.customer_name)}
                      </div>
                    )}
                    <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white ${propMeta.dot}`} />
                  </div>

                  {/* 名前・ステータス・メッセージ */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                      <span className="text-[14px] font-bold text-[#111b21] truncate">{c.customer_name}</span>
                      {conv?.account && (
                        <span className="shrink-0 rounded-full bg-[#e9edef] px-1.5 py-0.5 text-[9px] font-bold text-[#667781]">
                          {ACCT_LABEL[conv.account] ?? conv.account}
                        </span>
                      )}
                      <span className="shrink-0 text-[9px] font-semibold text-[#8696a0]">{propMeta.label}</span>
                    </div>
                    {conv?.last_message ? (
                      <p className={`truncate text-[12px] ${u === "reply" ? "font-semibold text-red-500" : "text-[#667781]"}`}>
                        {conv.last_message}
                      </p>
                    ) : (
                      <p className="text-[12px] text-[#bbb]">メッセージなし</p>
                    )}
                  </div>

                  {/* 時間 + chevron */}
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <span className="text-[10px] text-[#667781]">{relTime(conv?.updated_at)}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#90caf9" strokeWidth="2" strokeLinecap="round"
                      className={`transition-transform duration-200 ${isExp ? "rotate-180" : ""}`}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </button>

                {/* ── 物件条件 ── */}
                <div className="border-t border-[#f0f2f5] px-4 py-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {c.desired_area && <Tag label="エリア" value={c.desired_area} />}
                    {c.floor_plan   && <Tag label="間取り" value={c.floor_plan} />}
                    {c.floor_area_min && <Tag label="広さ" value={`${c.floor_area_min}㎡以上`} />}
                    {(c.rent_min || c.rent_max) && (
                      <Tag label="家賃" value={`${c.rent_min ? Math.floor(c.rent_min/10000)+"万〜" : "〜"}${c.rent_max ? Math.floor(c.rent_max/10000)+"万" : ""}`} />
                    )}
                    {c.walk_minutes && <Tag label="徒歩" value={`${c.walk_minutes}分`} />}
                    {c.move_in_time && <Tag label="入居" value={c.move_in_time} />}
                    {c.building_age && <Tag label="築年" value={`${c.building_age}年`} />}
                    {c.initial_cost_limit && <Tag label="初期" value={`${Math.floor(c.initial_cost_limit/10000)}万以内`} />}
                  </div>
                  {(c.preferences || c.ng_points) && (
                    <div className="mt-1.5 space-y-0.5">
                      {c.preferences && (
                        <p className="text-[11px] text-[#555]">
                          <span className="font-semibold text-[#8696a0]">希望　</span>{c.preferences}
                        </p>
                      )}
                      {c.ng_points && (
                        <p className="text-[11px] text-[#555]">
                          <span className="font-semibold text-[#8696a0]">NG　　</span>{c.ng_points}
                        </p>
                      )}
                    </div>
                  )}
                  {!c.desired_area && !c.floor_plan && !c.rent_min && !c.rent_max && !c.preferences && !c.ng_points && !c.additional_conditions && (
                    <p className="text-[11px] text-[#bbb]">条件未入力</p>
                  )}

                  {/* 新着要望（カジュアル更新ログ） */}
                  {c.additional_conditions && (
                    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-bold text-amber-700">新着要望</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); clearAdditional(c.id); }}
                          className="text-[9px] text-amber-400 active:opacity-60"
                        >
                          確認済・クリア
                        </button>
                      </div>
                      {c.additional_conditions.split("\n").map((line, i) => (
                        <p key={i} className="text-[11px] text-amber-800 leading-relaxed">{line}</p>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── アクション行 ── */}
                <div className="flex items-center gap-2 border-t border-[#f0f2f5] bg-[#fafafa] px-4 py-2">
                  {c.status !== "pending" && (
                    <button
                      onClick={() => markSent(c.id)}
                      disabled={sentUpdating === c.id}
                      className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 active:scale-95 transition-transform disabled:opacity-50"
                    >
                      {sentUpdating === c.id ? "…" : "物件送った"}
                    </button>
                  )}
                  {c.status !== "pending" && (
                    <button
                      onClick={() => markViewed(c.id)}
                      disabled={viewedUpdating === c.id}
                      className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 active:scale-95 transition-transform disabled:opacity-50"
                    >
                      {viewedUpdating === c.id ? "…" : "物件確認した"}
                    </button>
                  )}
                  <button
                    onClick={() => openEdit(c)}
                    className="rounded-xl border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-bold text-[#444] active:scale-95 transition-transform"
                  >
                    条件更新
                  </button>
                  {c.phone && (
                    <a href={`tel:${c.phone}`}
                      className="rounded-xl border border-[#d1d7db] bg-white px-3 py-1.5 text-xs font-bold text-[#444] active:scale-95 transition-transform">
                      電話
                    </a>
                  )}
                  <div className="ml-auto text-[10px] text-[#8696a0]">
                    {days === null
                      ? (c.status !== "pending" ? <span className="text-orange-400 font-semibold">未送信</span> : null)
                      : days === 0 ? "今日送信"
                      : <span className={days >= 3 ? "text-red-400 font-semibold" : ""}>{days}日前</span>}
                  </div>
                </div>

                {/* ── 展開パネル ── */}
                {isExp && (
                  <div className="border-t border-[#f0f2f5] px-4 py-3 space-y-2.5">
                    {(c.property_memo || c.other_requests || c.assignee) && (
                      <div className="text-[11px] text-[#555] space-y-0.5">
                        {c.assignee       && <p><span className="font-semibold text-[#8696a0]">担当　　</span>{c.assignee}</p>}
                        {c.property_memo  && <p><span className="font-semibold text-[#8696a0]">メモ　　</span>{c.property_memo}</p>}
                        {c.other_requests && <p><span className="font-semibold text-[#8696a0]">その他　</span>{c.other_requests}</p>}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {["new_inquiry","hot","property_search","pending"]
                        .filter((s) => s !== c.status)
                        .map((s) => {
                          const m = PROP_STATUS[s];
                          return (
                            <button key={s}
                              onClick={async () => {
                                await fetch("/api/property-customers", { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({id:c.id, status:s}) });
                                setCustomers((p) => p.map((x) => x.id === c.id ? {...x, status:s} : x));
                                setExpandedId(null);
                              }}
                              className="rounded-xl border border-[#e9edef] bg-white px-3 py-1.5 text-xs font-bold text-[#555] active:scale-95 transition-transform"
                            >
                              {m.label}に変更
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

      {/* ── 条件編集モーダル ── */}
      {editId && editFields && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setEditId(null); setEditFields(null); } }}>
          <div className="w-full rounded-t-2xl bg-white overflow-y-auto"
            style={{ maxHeight: "85svh", paddingBottom: "max(env(safe-area-inset-bottom),20px)" }}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#f0f2f5] sticky top-0 bg-white z-10">
              <div>
                <h2 className="font-bold text-[#111b21] text-[15px]">条件更新</h2>
                <p className="text-[11px] text-[#8696a0]">{customers.find((c) => c.id === editId)?.customer_name}</p>
              </div>
              <button onClick={() => { setEditId(null); setEditFields(null); }} className="text-[#aaa] text-xl leading-none">✕</button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <Field label="エリア" placeholder="例: 城東区・東大阪市"
                value={editFields.desired_area} onChange={(v) => setEditFields((f) => f && ({ ...f, desired_area: v }))} />
              <Field label="間取り" placeholder="例: 1LDK・2DK"
                value={editFields.floor_plan} onChange={(v) => setEditFields((f) => f && ({ ...f, floor_plan: v }))} />
              <Field label="広さ（㎡以上）" placeholder="例: 30" type="number"
                value={editFields.floor_area_min} onChange={(v) => setEditFields((f) => f && ({ ...f, floor_area_min: v }))} />
              <div className="flex gap-2">
                <div className="flex-1">
                  <Field label="家賃 下限（万）" placeholder="5" type="number"
                    value={editFields.rent_min} onChange={(v) => setEditFields((f) => f && ({ ...f, rent_min: v }))} />
                </div>
                <div className="flex-1">
                  <Field label="家賃 上限（万）" placeholder="7" type="number"
                    value={editFields.rent_max} onChange={(v) => setEditFields((f) => f && ({ ...f, rent_max: v }))} />
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Field label="駅徒歩（分）" placeholder="15" type="number"
                    value={editFields.walk_minutes} onChange={(v) => setEditFields((f) => f && ({ ...f, walk_minutes: v }))} />
                </div>
                <div className="flex-1">
                  <Field label="築年数以内" placeholder="20" type="number"
                    value={editFields.building_age} onChange={(v) => setEditFields((f) => f && ({ ...f, building_age: v }))} />
                </div>
              </div>
              <Field label="入居時期" placeholder="例: 7月・なるべく早く"
                value={editFields.move_in_time} onChange={(v) => setEditFields((f) => f && ({ ...f, move_in_time: v }))} />
              <Field label="初期費用上限（万）" placeholder="30" type="number"
                value={editFields.initial_cost_limit} onChange={(v) => setEditFields((f) => f && ({ ...f, initial_cost_limit: v }))} />
              <Field label="こだわり" placeholder="例: オートロック・ペット可・駐車場あり" textarea
                value={editFields.preferences} onChange={(v) => setEditFields((f) => f && ({ ...f, preferences: v }))} />
              <Field label="NG条件" placeholder="例: 1階NG・木造NG" textarea
                value={editFields.ng_points} onChange={(v) => setEditFields((f) => f && ({ ...f, ng_points: v }))} />
              <Field label="メモ" placeholder="社内メモ" textarea
                value={editFields.property_memo} onChange={(v) => setEditFields((f) => f && ({ ...f, property_memo: v }))} />
              <Field label="その他" placeholder="その他の要望" textarea
                value={editFields.other_requests} onChange={(v) => setEditFields((f) => f && ({ ...f, other_requests: v }))} />
            </div>
            <div className="px-5">
              <button onClick={saveEdit} disabled={editSaving}
                className="w-full py-3 rounded-xl font-bold text-white text-sm disabled:opacity-40 active:scale-[0.98] transition-transform"
                style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
                {editSaving ? "保存中..." : "保存する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 追加モーダル ── */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}>
          <div className="w-full rounded-t-2xl bg-white px-5 py-5 space-y-3"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom),20px)" }}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-[#111b21] text-base">お客さん追加</h2>
              <button onClick={() => setShowAdd(false)} className="text-[#aaa] text-xl leading-none">✕</button>
            </div>
            <Field label="お客さん名 *" placeholder="例: 田中さん" value={newName} onChange={setNewName} />
            <Field label="電話番号" placeholder="090-1234-5678" type="tel" value={newPhone} onChange={setNewPhone} />
            <Field label="担当者" placeholder="例: 竹内" value={newAssignee} onChange={setNewAssignee} />
            <button onClick={addCustomer} disabled={!newName.trim() || addLoading}
              className="w-full py-3 rounded-xl font-bold text-white text-sm disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, #1565C0, #2196F3)" }}>
              {addLoading ? "追加中..." : "追加する"}
            </button>
          </div>
        </div>
      )}

      <BottomNav />
    </div>
  );
}

// ── 条件タグ（絵文字なし・ラベル+値） ──
function Tag({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1 rounded-lg border border-[#e9edef] bg-[#f8f9fa] px-2 py-0.5">
      <span className="text-[9px] font-semibold text-[#8696a0] shrink-0">{label}</span>
      <span className="text-[11px] font-semibold text-[#333]">{value}</span>
    </span>
  );
}

// ── フォーム入力部品 ──
function Field({
  label, placeholder, value, onChange, textarea = false, type = "text",
}: {
  label: string; placeholder: string; value: string;
  onChange: (v: string) => void; textarea?: boolean; type?: string;
}) {
  const base = "w-full border border-[#e9edef] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#2196F3]";
  return (
    <div>
      <label className="text-[11px] font-semibold text-[#8696a0] mb-1 block">{label}</label>
      {textarea ? (
        <textarea className={base} rows={2} placeholder={placeholder} value={value}
          onChange={(e) => onChange(e.target.value)} style={{ resize: "none" }} />
      ) : (
        <input type={type} className={base} placeholder={placeholder} value={value}
          onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
