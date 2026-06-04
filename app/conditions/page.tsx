"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/app/lib/supabase";
import BottomNav from "@/app/components/BottomNav";

function SendTaskListButton() {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string>("");

  const handleSend = async () => {
    setSending(true);
    setResult("");
    try {
      const res = await fetch("/api/send-property-list", { method: "POST" });
      const data = await res.json() as { ok: boolean; count?: number; error?: string };
      setResult(data.ok ? `✅ ${data.count}名送信` : `❌ ${data.error}`);
    } catch {
      setResult("❌ エラー");
    } finally {
      setSending(false);
      setTimeout(() => setResult(""), 3000);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={handleSend}
        disabled={sending}
        className="flex items-center gap-1 rounded-full bg-[#06c755] px-2.5 py-1 text-[10px] font-bold text-white disabled:opacity-50 active:opacity-70"
      >
        {sending ? "送信中..." : "📲 LINE送信"}
      </button>
      {result && <span className="text-[10px] text-slate-500">{result}</span>}
    </div>
  );
}

type Status = "new_inquiry" | "hot" | "property_search" | "pending";

type Account = "sumora" | "ieyasu" | "giga" | "hasu";

const ACCOUNT_LABELS: Record<Account, string> = {
  sumora: "スモラ",
  ieyasu: "イエヤス",
  giga:   "ギガ賃貸",
  hasu:   "蓮産業",
};

interface Customer {
  id: string;
  customer_name: string;
  line_user_id?: string;
  phone?: string;
  status: Status;
  account?: Account;
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
  additional_conditions?: string;
  raw_format_text?: string;
  created_at: string;
  updated_at: string;
}

const STATUS_LABELS: Record<Status, string> = {
  new_inquiry: "新規問い合わせ",
  hot: "毎日物件出し",
  property_search: "物件出し",
  pending: "検討中",
};

const STATUS_META: Record<Status, { chip: string; dot: string }> = {
  new_inquiry: { chip: "bg-red-50 text-red-700",    dot: "bg-red-500" },
  hot:         { chip: "bg-orange-50 text-orange-700", dot: "bg-orange-400" },
  property_search: { chip: "bg-blue-50 text-blue-700",  dot: "bg-blue-400" },
  pending:     { chip: "bg-gray-100 text-gray-500",  dot: "bg-gray-300" },
};

const EMPTY_FORM: Omit<Customer, "id" | "created_at" | "updated_at"> = {
  customer_name: "",
  line_user_id: "",
  phone: "",
  status: "new_inquiry",
  account: undefined,
  assignee: "",
  area: "",
  max_rent: undefined,
  layout: "",
  preferences: "",
  ng_points: "",
  property_memo: "",
  last_property_sent_at: undefined,
  format_received: false,
  move_in_time: "",
  rent_min: undefined,
  rent_max: undefined,
  desired_area: "",
  walk_minutes: undefined,
  floor_plan: "",
  initial_cost_limit: undefined,
  building_age: undefined,
  other_requests: "",
  additional_conditions: "",
  raw_format_text: "",
};

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
  return Math.floor((Date.now() - new Date(c.last_property_sent_at).getTime()) / 86400000);
}

const INPUT =
  "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none bg-white";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1 font-medium">{label}</label>
      {children}
    </div>
  );
}

export default function ConditionsPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"announce" | "list">("announce");
  const [listFilter, setListFilter] = useState<Status | "all">("all");
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [form, setForm] = useState<Omit<Customer, "id" | "created_at" | "updated_at">>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dbReady, setDbReady] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sentMarkingId, setSentMarkingId] = useState<string | null>(null);

  const handleMarkSent = async (e: React.MouseEvent, customerId: string) => {
    e.stopPropagation();
    setSentMarkingId(customerId);
    await fetch("/api/property-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: customerId }),
    });
    const now = new Date().toISOString();
    setCustomers((prev) => prev.map((c) => c.id === customerId ? { ...c, last_property_sent_at: now } : c));
    setSentMarkingId(null);
  };

  // 紐付け済み property_customer_id セット
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());

  // クイックアクションシート
  const [quickTarget, setQuickTarget] = useState<Customer | null>(null);

  // フォーマット貼り付け
  const [formatText, setFormatText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // 元のLINE文表示
  const [showRawFormat, setShowRawFormat] = useState(false);

  async function load() {
    setLoading(true);
    const [res, { data: convData }] = await Promise.all([
      fetch("/api/property-customers"),
      supabase.from("conversations").select("property_customer_id").not("property_customer_id", "is", null),
    ]);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.error?.includes("does not exist") || err.error?.includes("relation")) {
        setDbReady(false);
      }
      setLoading(false);
      return;
    }
    const data: Customer[] = await res.json();
    setCustomers(data);
    if (convData) {
      setLinkedIds(new Set(convData.map((r: { property_customer_id: string }) => r.property_customer_id)));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openAdd() {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setError(null);
    setFormatText("");
    setParseError(null);
    setShowModal(true);
  }

  async function openEdit(c: Customer) {
    setEditTarget(c);

    // line_user_id が未設定かつ紐付け済み会話がある場合は自動取得
    let lineUserId = c.line_user_id ?? "";
    if (!lineUserId && linkedIds.has(c.id)) {
      const { data } = await supabase
        .from("conversations")
        .select("line_user_id")
        .eq("property_customer_id", c.id)
        .limit(1)
        .single();
      if (data?.line_user_id) lineUserId = data.line_user_id as string;
    }

    setForm({
      customer_name: c.customer_name,
      line_user_id: lineUserId,
      phone: c.phone ?? "",
      status: c.status,
      account: c.account ?? undefined,
      assignee: c.assignee ?? "",
      area: c.area ?? "",
      max_rent: c.max_rent,
      layout: c.layout ?? "",
      preferences: c.preferences ?? "",
      ng_points: c.ng_points ?? "",
      property_memo: c.property_memo ?? "",
      last_property_sent_at: c.last_property_sent_at,
      format_received: c.format_received ?? false,
      move_in_time: c.move_in_time ?? "",
      rent_min: c.rent_min,
      rent_max: c.rent_max,
      desired_area: c.desired_area ?? "",
      walk_minutes: c.walk_minutes,
      floor_plan: c.floor_plan ?? "",
      initial_cost_limit: c.initial_cost_limit,
      building_age: c.building_age,
      other_requests: c.other_requests ?? "",
      additional_conditions: c.additional_conditions ?? "",
      raw_format_text: c.raw_format_text ?? "",
    });
    setError(null);
    setFormatText(c.raw_format_text ?? "");
    setParseError(null);
    setQuickTarget(null);
    setShowModal(true);
  }

  async function save() {
    if (!form.customer_name.trim()) { setError("お客様名は必須です"); return; }
    setSaving(true);
    setError(null);

    const payload = {
      ...form,
      max_rent: form.max_rent || null,
      rent_min: form.rent_min || null,
      rent_max: form.rent_max || null,
      walk_minutes: form.walk_minutes || null,
      initial_cost_limit: form.initial_cost_limit || null,
      building_age: form.building_age || null,
    };

    let res: Response;
    if (editTarget) {
      res = await fetch("/api/property-customers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editTarget.id, ...payload }),
      });
    } else {
      res = await fetch("/api/property-customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setError(err.error ?? "保存に失敗しました");
      setSaving(false);
      return;
    }
    setSaving(false);
    setShowModal(false);
    load();
  }

  async function deleteCustomer(id: string) {
    if (!confirm("このお客様を削除しますか？")) return;
    await fetch(`/api/property-customers?id=${id}`, { method: "DELETE" });
    setShowModal(false);
    load();
  }

  async function markSent(id: string) {
    setMarkingId(id);
    await fetch("/api/property-customers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, last_property_sent_at: new Date().toISOString() }),
    });
    setMarkingId(null);
    setQuickTarget(null);
    load();
  }

  async function parseFormat() {
    if (!formatText.trim()) return;
    setParsing(true);
    setParseError(null);
    try {
      const res = await fetch("/api/parse-format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: formatText }),
      });
      if (!res.ok) throw new Error("解析失敗");
      const data = await res.json();
      setForm((prev) => ({
        ...prev,
        format_received: true,
        raw_format_text: formatText,
        move_in_time: data.move_in_time ?? prev.move_in_time,
        rent_min: data.rent_min ?? prev.rent_min,
        rent_max: data.rent_max ?? prev.rent_max,
        desired_area: data.desired_area ?? prev.desired_area,
        walk_minutes: data.walk_minutes ?? prev.walk_minutes,
        floor_plan: data.floor_plan ?? prev.floor_plan,
        initial_cost_limit: data.initial_cost_limit ?? prev.initial_cost_limit,
        building_age: data.building_age ?? prev.building_age,
        other_requests: data.other_requests ?? prev.other_requests,
      }));
    } catch {
      setParseError("AI解析に失敗しました。もう一度お試しください。");
    }
    setParsing(false);
  }

  // 一覧タブの展開状態
  const [expandedListId, setExpandedListId] = useState<string | null>(null);

  function formatRent(c: Customer): string | null {
    const min = c.rent_min;
    const max = c.rent_max || c.max_rent;
    if (!min && !max) return null;
    if (min && max) return `${Math.floor(min / 10000)}万〜${Math.floor(max / 10000)}万円`;
    if (max) return `〜${Math.floor(max / 10000)}万円`;
    return `${Math.floor(min! / 10000)}万円〜`;
  }

  const q = searchQuery.trim().toLowerCase();
  function matchesSearch(c: Customer): boolean {
    if (!q) return true;
    return [
      c.customer_name,
      c.desired_area,
      c.area,
      c.preferences,
      c.ng_points,
      c.other_requests,
      c.additional_conditions,
      c.floor_plan,
      c.layout,
      c.move_in_time,
    ].some((v) => v && v.toLowerCase().includes(q));
  }
  const actionNeeded = customers.filter(needsActionToday);
  const listFiltered = (listFilter === "all" ? customers : customers.filter((c) => c.status === listFilter)).filter(matchesSearch);

  return (
    <div className="bg-slate-50 flex flex-col pb-16" style={{ height: "100svh", overflowY: "auto" }}>
      {/* ── ヘッダー（LINEページ風: 白背景） ── */}
      <header
        className="sticky top-0 z-20 flex items-center justify-between px-4"
        style={{
          background: "white",
          borderBottom: "1px solid #e9edef",
          paddingTop: "max(env(safe-area-inset-top), 12px)",
          paddingBottom: 10,
        }}
      >
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-slate-800">売上サポ</h1>
          <span className="text-xs text-slate-400">全{customers.length}件</span>
          <SendTaskListButton />
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-bold text-white"
          style={{ background: "#1565C0" }}
        >
          <span className="text-base leading-none">＋</span>
          <span>追加</span>
        </button>
      </header>

      {/* ── タブ ── */}
      <div
        className="flex sticky z-10 bg-white"
        style={{ top: 53, borderBottom: "1px solid #e9edef" }}
      >
        {(["announce", "list"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 py-2.5 text-sm font-bold transition-colors relative"
            style={{ color: tab === t ? "#1565C0" : "#90a4ae" }}
          >
            {t === "announce" ? (
              <span className="flex items-center justify-center gap-1.5">
                アナウンス
                {actionNeeded.length > 0 && (
                  <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                    {actionNeeded.length}
                  </span>
                )}
              </span>
            ) : "一覧"}
            {tab === t && (
              <span
                className="absolute bottom-0 left-4 right-4 h-0.5 rounded-full"
                style={{ background: "#1565C0" }}
              />
            )}
          </button>
        ))}
      </div>

      {!dbReady && (
        <div className="mx-4 mt-4 p-4 bg-amber-50 border border-amber-300 rounded-xl text-sm">
          <p className="font-bold text-amber-800 mb-2">⚠️ テーブルが未作成です</p>
          <p className="text-amber-700">
            Supabase SQL Editor で{" "}
            <a href="/api/migrate-schema" target="_blank" className="underline font-bold">
              /api/migrate-schema
            </a>{" "}
            のSQLを実行してください。
          </p>
        </div>
      )}

      {loading ? (
        <p className="text-center text-slate-400 py-16 text-sm">読み込み中...</p>
      ) : (
        <div className="flex-1 pb-28">
          {/* ── アナウンスタブ ── */}
          {tab === "announce" && (
            <div className="mt-2">
              {actionNeeded.length === 0 ? (
                <div className="text-center py-20">
                  <p className="text-4xl mb-3">🎉</p>
                  <p className="text-slate-500 text-sm font-bold">今日の対応は全て完了！！</p>
                </div>
              ) : (
                <>
                  <p className="px-4 pt-3 pb-1.5 text-xs text-slate-400 font-bold">
                    今日対応が必要 {actionNeeded.length}名
                  </p>
                  <div className="bg-white border-y border-slate-100 divide-y divide-slate-50">
                    {actionNeeded.map((c) => {
                      const days = daysSinceSent(c);
                      const meta = STATUS_META[c.status];
                      return (
                        <button
                          key={c.id}
                          onClick={() => setQuickTarget(c)}
                          className="w-full text-left flex items-center gap-3 px-4 py-3.5 active:bg-slate-50 transition-colors"
                        >
                          {/* ステータスドット */}
                          <div className={`w-3 h-3 rounded-full flex-shrink-0 ${meta.dot}`} />

                          {/* コンテンツ */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                              <span className="font-bold text-slate-800 text-sm">{c.customer_name}</span>
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${meta.chip}`}>
                                {STATUS_LABELS[c.status]}
                              </span>
                              {linkedIds.has(c.id) && (
                                <span className="text-[10px] bg-blue-50 text-blue-600 font-bold px-1.5 py-0.5 rounded-full flex-shrink-0">
                                  紐付け済
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-slate-400 flex-wrap">
                              {(c.desired_area || c.area) && <span>{c.desired_area || c.area}</span>}
                              {(c.rent_max || c.max_rent) && <span>〜{((c.rent_max || c.max_rent)! / 10000).toFixed(1)}万</span>}
                              {(c.floor_plan || c.layout) && <span>{c.floor_plan || c.layout}</span>}
                              {days !== null ? (
                                <span className={days >= 1 ? "text-orange-500 font-bold" : "text-emerald-600"}>
                                  {days === 0 ? "今日送信済" : `${days}日前送信`}
                                </span>
                              ) : (
                                <span className="text-red-500 font-bold">未送信</span>
                              )}
                            </div>
                          </div>

                          {/* タップヒント */}
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c5d8e8" strokeWidth="2">
                            <path d="M9 18l6-6-6-6"/>
                          </svg>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── 一覧タブ ── */}
          {tab === "list" && (
            <div className="mt-2">
              {/* フィルター */}
              <div className="flex gap-2 px-4 pt-3 pb-2.5 overflow-x-auto">
                {(["all", "new_inquiry", "hot", "property_search", "pending"] as const).map((s) => {
                  const isActive = listFilter === s;
                  return (
                    <button
                      key={s}
                      onClick={() => setListFilter(s)}
                      className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-bold border transition-all ${
                        isActive
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-slate-500 border-slate-200"
                      }`}
                    >
                      {s === "all" ? "全て" : STATUS_LABELS[s]}
                    </button>
                  );
                })}
              </div>

              {/* 検索バー */}
              <div className="px-4 pb-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="名前・エリア・条件で検索..."
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none"
                />
              </div>

              {listFiltered.length === 0 ? (
                <div className="text-center py-16">
                  <p className="text-slate-400 text-sm">{q ? "該当するお客様がいません" : "お客様がいません"}</p>
                  {!q && (
                    <button onClick={openAdd} className="mt-4 text-blue-600 text-sm underline">
                      ＋ 新規追加
                    </button>
                  )}
                </div>
              ) : (
                <div className="bg-white border-y border-slate-100 divide-y divide-slate-50">
                  {listFiltered.map((c) => {
                    const days = daysSinceSent(c);
                    const meta = STATUS_META[c.status];
                    const isExpanded = expandedListId === c.id;
                    const rent = formatRent(c);
                    const isLinked = linkedIds.has(c.id);

                    // 表示する条件項目
                    const condItems: { label: string; value: string }[] = [];
                    if (c.move_in_time) condItems.push({ label: "入居時期", value: c.move_in_time });
                    if (c.desired_area || c.area) condItems.push({ label: "エリア", value: (c.desired_area || c.area)! });
                    if (rent) condItems.push({ label: "家賃", value: rent });
                    if (c.walk_minutes) condItems.push({ label: "徒歩", value: `${c.walk_minutes}分以内` });
                    if (c.floor_plan || c.layout) condItems.push({ label: "間取り", value: (c.floor_plan || c.layout)! });
                    if (c.building_age) condItems.push({ label: "築年数", value: `${c.building_age}年以内` });
                    if (c.initial_cost_limit) condItems.push({ label: "初期費用", value: `${Math.floor(c.initial_cost_limit / 10000)}万以内` });

                    return (
                      <div key={c.id}>
                        {/* サマリー行（タップで展開） */}
                        <button
                          onClick={() => setExpandedListId(isExpanded ? null : c.id)}
                          className="w-full text-left flex items-center gap-3 px-4 py-3.5 active:bg-slate-50 transition-colors"
                        >
                          <div className={`w-3 h-3 rounded-full flex-shrink-0 ${meta.dot}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                              <span className="font-bold text-slate-800 text-sm">{c.customer_name}</span>
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${meta.chip}`}>
                                {STATUS_LABELS[c.status]}
                              </span>
                              {isLinked && (
                                <span className="text-[10px] bg-blue-50 text-blue-600 font-bold px-1.5 py-0.5 rounded-full flex-shrink-0">
                                  紐付け済
                                </span>
                              )}
                              {c.format_received && (
                                <span className="text-[10px] bg-green-50 text-green-700 font-bold px-1.5 py-0.5 rounded-full">
                                  フォーマット済
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-slate-400 flex-wrap">
                              {(c.desired_area || c.area) && <span>{c.desired_area || c.area}</span>}
                              {rent && <span>{rent}</span>}
                              {(c.floor_plan || c.layout) && <span>{c.floor_plan || c.layout}</span>}
                              {c.assignee && <span>担当: {c.assignee}</span>}
                              {days !== null ? (
                                <span className={days >= 3 ? "text-orange-500 font-bold" : ""}>
                                  {days === 0 ? "今日送信" : `${days}日前`}
                                </span>
                              ) : (
                                c.status !== "pending" && <span className="text-red-400 font-bold">未送信</span>
                              )}
                            </div>
                          </div>
                          {/* 送ったボタン */}
                          {c.status !== "pending" && (
                            <button
                              onClick={(e) => handleMarkSent(e, c.id)}
                              disabled={sentMarkingId === c.id}
                              className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold border active:opacity-70 disabled:opacity-50"
                              style={
                                daysSinceSent(c) === 0
                                  ? { borderColor: "#86efac", color: "#16a34a", background: "#f0fdf4" }
                                  : { borderColor: "#d1d5db", color: "#6b7280", background: "#f9fafb" }
                              }
                            >
                              {sentMarkingId === c.id ? "..." : daysSinceSent(c) === 0 ? "✅送信済" : "📤送った"}
                            </button>
                          )}
                          {/* 展開チェブロン */}
                          <svg
                            width="16" height="16" viewBox="0 0 24 24" fill="none"
                            stroke="#c5d8e8" strokeWidth="2" strokeLinecap="round"
                            className={`flex-shrink-0 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

                        {/* 展開：全条件表示 */}
                        {isExpanded && (
                          <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 space-y-3">
                            {condItems.length > 0 ? (
                              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                                {condItems.map(({ label, value }) => (
                                  <div key={label}>
                                    <p className="text-[10px] text-slate-400 font-medium mb-0.5">{label}</p>
                                    <p className="text-xs text-slate-700 font-bold">{value}</p>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-slate-400">条件がまだ入力されていません</p>
                            )}

                            {/* テキスト系条件（全幅） */}
                            {(c.preferences || c.ng_points || c.other_requests || c.property_memo) && (
                              <div className="space-y-1.5 pt-1 border-t border-slate-200">
                                {c.preferences && (
                                  <div>
                                    <span className="text-[10px] text-slate-400 font-medium">こだわり  </span>
                                    <span className="text-xs text-slate-700">{c.preferences}</span>
                                  </div>
                                )}
                                {c.ng_points && (
                                  <div>
                                    <span className="text-[10px] text-slate-400 font-medium">NG  </span>
                                    <span className="text-xs text-slate-700">{c.ng_points}</span>
                                  </div>
                                )}
                                {c.other_requests && (
                                  <div>
                                    <span className="text-[10px] text-slate-400 font-medium">その他  </span>
                                    <span className="text-xs text-slate-700">{c.other_requests}</span>
                                  </div>
                                )}
                                {c.property_memo && (
                                  <div>
                                    <span className="text-[10px] text-slate-400 font-medium">物件メモ  </span>
                                    <span className="text-xs text-slate-700">{c.property_memo}</span>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* 追加条件（LINEで届いた追加メッセージ） */}
                            {c.additional_conditions && (
                              <div className="pt-1 border-t border-slate-200">
                                <p className="text-[10px] text-slate-400 font-medium mb-1">追加条件</p>
                                <p className="text-xs text-slate-700 whitespace-pre-wrap">{c.additional_conditions}</p>
                              </div>
                            )}

                            {/* LINEで届いた原文 */}
                            {c.raw_format_text && (
                              <div className="pt-1 border-t border-slate-200">
                                <p className="text-[10px] text-slate-400 font-medium mb-1">📨 LINEで届いた原文</p>
                                <p className="text-xs text-slate-600 whitespace-pre-wrap bg-white rounded-lg px-3 py-2 border border-slate-100">{c.raw_format_text}</p>
                              </div>
                            )}

                            {/* 編集ボタン */}
                            <button
                              onClick={(e) => { e.stopPropagation(); openEdit(c); }}
                              className="w-full py-2.5 rounded-xl text-sm font-bold border border-blue-200 text-blue-600 bg-white"
                            >
                              編集する
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── クイックアクションシート（アナウンスタップ時） ── */}
      {quickTarget && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setQuickTarget(null); setShowRawFormat(false); } }}
        >
          <div
            className="w-full bg-white rounded-t-2xl px-5 py-5 space-y-3"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 20px)" }}
          >
            {/* お客様名 + ステータス */}
            <div className="flex items-center gap-2 pb-1">
              <div className={`w-3 h-3 rounded-full flex-shrink-0 ${STATUS_META[quickTarget.status].dot}`} />
              <span className="font-bold text-slate-800 text-base">{quickTarget.customer_name}</span>
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${STATUS_META[quickTarget.status].chip}`}>
                {STATUS_LABELS[quickTarget.status]}
              </span>
            </div>

            {/* 全条件表示 */}
            {(() => {
              const qt = quickTarget;
              const rent = formatRent(qt);
              const gridItems: { label: string; value: string }[] = [];
              if (qt.move_in_time) gridItems.push({ label: "入居時期", value: qt.move_in_time });
              if (qt.desired_area || qt.area) gridItems.push({ label: "エリア", value: (qt.desired_area || qt.area)! });
              if (rent) gridItems.push({ label: "家賃", value: rent });
              if (qt.walk_minutes) gridItems.push({ label: "徒歩", value: `${qt.walk_minutes}分以内` });
              if (qt.floor_plan || qt.layout) gridItems.push({ label: "間取り", value: (qt.floor_plan || qt.layout)! });
              if (qt.building_age) gridItems.push({ label: "築年数", value: `${qt.building_age}年以内` });
              if (qt.initial_cost_limit) gridItems.push({ label: "初期費用", value: `${Math.floor(qt.initial_cost_limit / 10000)}万以内` });
              return (
                <div className="bg-slate-50 rounded-xl p-3 space-y-2">
                  {gridItems.length > 0 && (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                      {gridItems.map(({ label, value }) => (
                        <div key={label}>
                          <p className="text-[10px] text-slate-400 font-medium mb-0.5">{label}</p>
                          <p className="text-xs text-slate-700 font-bold">{value}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {(qt.preferences || qt.ng_points || qt.other_requests) && (
                    <div className="space-y-1 pt-1.5 border-t border-slate-200">
                      {qt.preferences && (
                        <p className="text-xs text-slate-600"><span className="text-slate-400">こだわり  </span>{qt.preferences}</p>
                      )}
                      {qt.ng_points && (
                        <p className="text-xs text-slate-600"><span className="text-slate-400">NG  </span>{qt.ng_points}</p>
                      )}
                      {qt.other_requests && (
                        <p className="text-xs text-slate-600"><span className="text-slate-400">その他  </span>{qt.other_requests}</p>
                      )}
                    </div>
                  )}
                  {qt.additional_conditions && (
                    <div className="pt-1.5 border-t border-slate-200">
                      <p className="text-[10px] text-slate-400 font-medium mb-0.5">追加条件</p>
                      <p className="text-xs text-slate-700 whitespace-pre-wrap">{qt.additional_conditions}</p>
                    </div>
                  )}
                  {gridItems.length === 0 && !qt.preferences && !qt.ng_points && !qt.other_requests && !qt.additional_conditions && (
                    <p className="text-xs text-slate-400">条件が入力されていません</p>
                  )}
                </div>
              );
            })()}

            {/* ✅ 物件を送った（メインアクション・大きく） */}
            <button
              onClick={() => markSent(quickTarget.id)}
              disabled={markingId === quickTarget.id}
              className="w-full py-4 rounded-2xl font-bold text-white text-base disabled:opacity-50"
              style={{ background: "#43a047" }}
            >
              {markingId === quickTarget.id ? "記録中..." : "物件を送った"}
            </button>

            {/* 詳細編集 */}
            <button
              onClick={() => openEdit(quickTarget)}
              className="w-full py-3.5 rounded-2xl font-bold text-slate-600 text-sm border border-slate-200 bg-slate-50"
            >
              詳細を編集する
            </button>

            {/* 元のLINE文 */}
            {quickTarget.raw_format_text && (
              <>
                <button
                  onClick={() => setShowRawFormat((prev) => !prev)}
                  className="w-full py-3.5 rounded-2xl font-bold text-blue-600 text-sm border border-blue-100 bg-blue-50"
                >
                  {showRawFormat ? "▲ LINEフォーマットを閉じる" : "📋 元のLINE文を見る"}
                </button>
                {showRawFormat && (
                  <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200">
                    <p className="text-[10px] text-slate-400 font-bold mb-2">受信したLINEフォーマット</p>
                    <p className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">
                      {quickTarget.raw_format_text}
                    </p>
                  </div>
                )}
              </>
            )}

            {/* キャンセル */}
            <button
              onClick={() => { setQuickTarget(null); setShowRawFormat(false); }}
              className="w-full py-3 text-slate-400 text-sm font-medium"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* ── 詳細編集モーダル ── */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <div className="w-full max-w-lg bg-white rounded-t-2xl shadow-2xl max-h-[75vh] flex flex-col">
            {/* ヘッダー */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-800">
                {editTarget ? "お客様情報を編集" : "新規お客様追加"}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-slate-400 text-2xl leading-none">×</button>
            </div>

            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {error && (
                <p className="text-red-600 text-sm bg-red-50 rounded-xl px-3 py-2">{error}</p>
              )}

              {/* ✅ 送ったボタン（編集時・一番上に大きく） */}
              {editTarget && (
                <button
                  onClick={async () => { await markSent(editTarget.id); setShowModal(false); }}
                  className="w-full py-3.5 rounded-2xl font-bold text-white text-sm"
                  style={{ background: "#43a047" }}
                >
                  ✅ 物件を送った
                </button>
              )}

              {/* 基本情報 */}
              <div className="space-y-3">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">基本情報</p>

                <Field label="アカウント名 *">
                  <input
                    className={INPUT}
                    value={form.customer_name}
                    onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                    placeholder="例：田中 太郎"
                  />
                </Field>

                {/* アカウント選択 */}
                <Field label="アカウント（LINE）">
                  <div className="flex gap-2 flex-wrap">
                    {(Object.entries(ACCOUNT_LABELS) as [Account, string][]).map(([key, label]) => {
                      const isSelected = form.account === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setForm({ ...form, account: isSelected ? undefined : key })}
                          className="flex-1 min-w-[72px] py-2 rounded-xl text-sm font-bold border-2 transition-all"
                          style={{
                            background: isSelected ? "#1565C0" : "white",
                            borderColor: isSelected ? "#1565C0" : "#e2e8f0",
                            color: isSelected ? "white" : "#64748b",
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </Field>

                <Field label="ステータス">
                  <select
                    className={INPUT}
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as Status })}
                  >
                    {Object.entries(STATUS_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </Field>

                <Field label="物件候補メモ">
                  <textarea
                    className={INPUT + " h-16 resize-none"}
                    value={form.property_memo ?? ""}
                    onChange={(e) => setForm({ ...form, property_memo: e.target.value })}
                    placeholder="例：〇〇マンション確認中・△△は送済み"
                  />
                </Field>
              </div>

              {/* LINEフォーマット */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">LINEフォーマット</p>
                  {form.format_received && (
                    <span className="text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded-full font-medium">
                      🌟 受信済み
                    </span>
                  )}
                </div>

                <Field label="フォーマットを貼り付けてAI解析">
                  <textarea
                    className={INPUT + " h-24 resize-none"}
                    value={formatText}
                    onChange={(e) => setFormatText(e.target.value)}
                    placeholder={"①入居時期：\n②希望家賃：\n③希望地域：\n..."}
                  />
                </Field>
                <button
                  onClick={parseFormat}
                  disabled={parsing || !formatText.trim()}
                  className="w-full bg-blue-600 text-white font-bold py-3 rounded-2xl text-sm disabled:opacity-40"
                >
                  {parsing ? "AI解析中..." : "AIで自動入力"}
                </button>
                {parseError && (
                  <p className="text-red-600 text-xs bg-red-50 rounded-xl px-3 py-2">{parseError}</p>
                )}
              </div>

              {/* 条件詳細 */}
              <div className="space-y-3 pt-2">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">条件詳細</p>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="入居時期">
                    <input className={INPUT} value={form.move_in_time ?? ""} onChange={(e) => setForm({ ...form, move_in_time: e.target.value })} placeholder="例：来月中" />
                  </Field>
                  <Field label="希望地域・駅">
                    <input className={INPUT} value={form.desired_area ?? ""} onChange={(e) => setForm({ ...form, desired_area: e.target.value })} placeholder="例：梅田・難波" />
                  </Field>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <Field label="家賃下限（円）">
                    <input className={INPUT} type="number" value={form.rent_min ?? ""} onChange={(e) => setForm({ ...form, rent_min: e.target.value ? Number(e.target.value) : undefined })} placeholder="50000" />
                  </Field>
                  <Field label="家賃上限（円）">
                    <input className={INPUT} type="number" value={form.rent_max ?? ""} onChange={(e) => setForm({ ...form, rent_max: e.target.value ? Number(e.target.value) : undefined })} placeholder="80000" />
                  </Field>
                  <Field label="徒歩（分）">
                    <input className={INPUT} type="number" value={form.walk_minutes ?? ""} onChange={(e) => setForm({ ...form, walk_minutes: e.target.value ? Number(e.target.value) : undefined })} placeholder="10" />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="間取り">
                    <input className={INPUT} value={form.floor_plan ?? ""} onChange={(e) => setForm({ ...form, floor_plan: e.target.value })} placeholder="例：1LDK以上" />
                  </Field>
                  <Field label="築年数（年以内）">
                    <input className={INPUT} type="number" value={form.building_age ?? ""} onChange={(e) => setForm({ ...form, building_age: e.target.value ? Number(e.target.value) : undefined })} placeholder="10" />
                  </Field>
                </div>

                <Field label="初期費用上限（円）">
                  <input className={INPUT} type="number" value={form.initial_cost_limit ?? ""} onChange={(e) => setForm({ ...form, initial_cost_limit: e.target.value ? Number(e.target.value) : undefined })} placeholder="例：300000" />
                </Field>

                <Field label="こだわり">
                  <textarea className={INPUT + " h-16 resize-none"} value={form.preferences ?? ""} onChange={(e) => setForm({ ...form, preferences: e.target.value })} placeholder="例：オートロック・独立洗面台" />
                </Field>

                <Field label="NGポイント">
                  <textarea className={INPUT + " h-16 resize-none"} value={form.ng_points ?? ""} onChange={(e) => setForm({ ...form, ng_points: e.target.value })} placeholder="例：1階・南向き以外" />
                </Field>

                <Field label="その他要望">
                  <textarea className={INPUT + " h-16 resize-none"} value={form.other_requests ?? ""} onChange={(e) => setForm({ ...form, other_requests: e.target.value })} placeholder="例：ペット可・駐車場あり" />
                </Field>

                <Field label="追加条件（LINEで届いた追加メッセージ）">
                  <textarea className={INPUT + " h-24 resize-none"} value={form.additional_conditions ?? ""} onChange={(e) => setForm({ ...form, additional_conditions: e.target.value })} placeholder="LINEから届いた追加条件が自動で保存されます" />
                </Field>
              </div>


              {editTarget && (
                <button
                  onClick={() => deleteCustomer(editTarget.id)}
                  className="w-full text-red-400 text-sm py-2.5 border border-red-100 rounded-xl hover:bg-red-50 transition-colors"
                >
                  このお客様を削除
                </button>
              )}
            </div>

            {/* フッター */}
            <div className="px-5 py-4 border-t border-slate-100">
              <button
                onClick={save}
                disabled={saving}
                className="w-full font-bold py-3.5 rounded-2xl disabled:opacity-50 text-white text-sm"
                style={{ background: "#1565C0" }}
              >
                {saving ? "保存中..." : editTarget ? "更新する" : "追加する"}
              </button>
            </div>
          </div>
        </div>
      )}

      <BottomNav />
    </div>
  );
}
