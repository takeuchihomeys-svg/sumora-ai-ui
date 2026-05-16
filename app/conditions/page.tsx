"use client";

import { useEffect, useState } from "react";
import BottomNav from "@/app/components/BottomNav";

type Priority = "urgent" | "normal" | "done";
type Status =
  | "first_reply"
  | "condition_hearing"
  | "property_search"
  | "property_recommendation"
  | "viewing"
  | "application";

interface Customer {
  id: string;
  customer_name: string;
  line_user_id?: string;
  phone?: string;
  status: Status;
  priority: Priority;
  assignee?: string;
  area?: string;
  max_rent?: number;
  layout?: string;
  preferences?: string;
  ng_points?: string;
  property_memo?: string;
  created_at: string;
  updated_at: string;
}

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "🔴 急ぎ",
  normal: "🟡 通常",
  done: "⚪ 完了",
};

const STATUS_LABELS: Record<Status, string> = {
  first_reply: "初回返信",
  condition_hearing: "条件ヒアリング",
  property_search: "物件探し中",
  property_recommendation: "物件紹介中",
  viewing: "内見予約",
  application: "申込",
};

const EMPTY_FORM: Omit<Customer, "id" | "created_at" | "updated_at"> = {
  customer_name: "",
  line_user_id: "",
  phone: "",
  status: "first_reply",
  priority: "normal",
  assignee: "",
  area: "",
  max_rent: undefined,
  layout: "",
  preferences: "",
  ng_points: "",
  property_memo: "",
};

export default function ConditionsPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Priority | "all">("all");
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [form, setForm] = useState<Omit<Customer, "id" | "created_at" | "updated_at">>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dbReady, setDbReady] = useState(true);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/property-customers");
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
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function openAdd() {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setError(null);
    setShowModal(true);
  }

  function openEdit(c: Customer) {
    setEditTarget(c);
    setForm({
      customer_name: c.customer_name,
      line_user_id: c.line_user_id ?? "",
      phone: c.phone ?? "",
      status: c.status,
      priority: c.priority,
      assignee: c.assignee ?? "",
      area: c.area ?? "",
      max_rent: c.max_rent,
      layout: c.layout ?? "",
      preferences: c.preferences ?? "",
      ng_points: c.ng_points ?? "",
      property_memo: c.property_memo ?? "",
    });
    setError(null);
    setShowModal(true);
  }

  async function save() {
    if (!form.customer_name.trim()) {
      setError("お客様名は必須です");
      return;
    }
    setSaving(true);
    setError(null);

    const payload = {
      ...form,
      max_rent: form.max_rent || null,
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
    load();
  }

  const filtered =
    filter === "all" ? customers : customers.filter((c) => c.priority === filter);

  const priorityColor: Record<Priority, string> = {
    urgent: "bg-red-100 border-red-300",
    normal: "bg-yellow-50 border-yellow-300",
    done: "bg-gray-50 border-gray-200",
  };

  const priorityBadge: Record<Priority, string> = {
    urgent: "bg-red-500 text-white",
    normal: "bg-yellow-400 text-white",
    done: "bg-gray-400 text-white",
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {/* ヘッダー */}
      <header className="sticky top-0 z-20 bg-blue-700 text-white px-4 py-3 flex items-center justify-between shadow-md">
        <div>
          <h1 className="text-lg font-bold leading-tight">物件条件管理</h1>
          <p className="text-xs text-blue-200">{customers.length}件</p>
        </div>
        <button
          onClick={openAdd}
          className="bg-white text-blue-700 font-bold text-sm px-4 py-2 rounded-xl shadow"
        >
          ＋ 新規追加
        </button>
      </header>

      {/* DBセットアップ案内 */}
      {!dbReady && (
        <div className="mx-4 mt-4 p-4 bg-amber-50 border border-amber-300 rounded-xl text-sm">
          <p className="font-bold text-amber-800 mb-2">⚠️ テーブルが未作成です</p>
          <p className="text-amber-700">
            Supabase ダッシュボードの SQL Editor で{" "}
            <a href="/api/migrate-schema" target="_blank" className="underline font-bold">
              /api/migrate-schema
            </a>{" "}
            のSQLを実行してください。
          </p>
        </div>
      )}

      {/* フィルタータブ */}
      <div className="flex gap-2 px-4 pt-4 pb-2 overflow-x-auto">
        {(["all", "urgent", "normal", "done"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setFilter(p)}
            className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              filter === p
                ? "bg-blue-700 text-white"
                : "bg-white text-slate-600 border border-slate-200"
            }`}
          >
            {p === "all" ? "全て" : PRIORITY_LABELS[p]}
          </button>
        ))}
      </div>

      {/* カード一覧 */}
      <div className="px-4 space-y-3 mt-1">
        {loading ? (
          <p className="text-center text-slate-400 py-12">読み込み中...</p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-slate-400 py-12">
            {filter === "all" ? "お客様がいません" : "該当するお客様がいません"}
          </p>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              className={`rounded-xl border-2 p-4 ${priorityColor[c.priority]} shadow-sm`}
            >
              {/* ヘッダー行 */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded-full ${priorityBadge[c.priority]}`}
                  >
                    {PRIORITY_LABELS[c.priority]}
                  </span>
                  <span className="font-bold text-slate-800">{c.customer_name}</span>
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                    {STATUS_LABELS[c.status] ?? c.status}
                  </span>
                </div>
                <button
                  onClick={() => openEdit(c)}
                  className="text-xs text-blue-600 underline whitespace-nowrap"
                >
                  編集
                </button>
              </div>

              {/* 条件情報 */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-700 mb-2">
                {c.area && (
                  <div>
                    <span className="text-slate-400 text-xs">エリア</span>
                    <p>{c.area}</p>
                  </div>
                )}
                {c.max_rent && (
                  <div>
                    <span className="text-slate-400 text-xs">賃料上限</span>
                    <p>{c.max_rent.toLocaleString()}円</p>
                  </div>
                )}
                {c.layout && (
                  <div>
                    <span className="text-slate-400 text-xs">間取り</span>
                    <p>{c.layout}</p>
                  </div>
                )}
                {c.assignee && (
                  <div>
                    <span className="text-slate-400 text-xs">担当者</span>
                    <p>{c.assignee}</p>
                  </div>
                )}
              </div>

              {c.preferences && (
                <div className="text-sm text-slate-700 mb-1">
                  <span className="text-slate-400 text-xs">こだわり</span>
                  <p>{c.preferences}</p>
                </div>
              )}
              {c.ng_points && (
                <div className="text-sm text-slate-700 mb-1">
                  <span className="text-slate-400 text-xs">NGポイント</span>
                  <p className="text-red-700">{c.ng_points}</p>
                </div>
              )}
              {c.property_memo && (
                <div className="mt-2 bg-white/70 rounded-lg px-3 py-2 text-sm text-slate-700 border border-slate-200">
                  <span className="text-slate-400 text-xs block">物件メモ</span>
                  <p className="whitespace-pre-wrap">{c.property_memo}</p>
                </div>
              )}

              <div className="flex justify-end mt-2">
                <button
                  onClick={() => deleteCustomer(c.id)}
                  className="text-xs text-red-400 underline"
                >
                  削除
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 追加・編集モーダル */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowModal(false);
          }}
        >
          <div className="w-full max-w-lg bg-white rounded-t-2xl shadow-2xl max-h-[90vh] flex flex-col">
            {/* モーダルヘッダー */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-800">
                {editTarget ? "お客様情報を編集" : "新規お客様追加"}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-slate-400 text-2xl leading-none"
              >
                ×
              </button>
            </div>

            {/* フォーム */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {error && (
                <p className="text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</p>
              )}

              <Field label="お客様名 *">
                <input
                  className={INPUT}
                  value={form.customer_name}
                  onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                  placeholder="例：田中 太郎"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="対応優先度">
                  <select
                    className={INPUT}
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}
                  >
                    <option value="urgent">🔴 急ぎ</option>
                    <option value="normal">🟡 通常</option>
                    <option value="done">⚪ 完了</option>
                  </select>
                </Field>

                <Field label="フェーズ">
                  <select
                    className={INPUT}
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as Status })}
                  >
                    {Object.entries(STATUS_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="エリア">
                  <input
                    className={INPUT}
                    value={form.area ?? ""}
                    onChange={(e) => setForm({ ...form, area: e.target.value })}
                    placeholder="例：梅田 徒歩10分"
                  />
                </Field>

                <Field label="賃料上限（円）">
                  <input
                    className={INPUT}
                    type="number"
                    value={form.max_rent ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, max_rent: e.target.value ? Number(e.target.value) : undefined })
                    }
                    placeholder="例：80000"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="間取り">
                  <input
                    className={INPUT}
                    value={form.layout ?? ""}
                    onChange={(e) => setForm({ ...form, layout: e.target.value })}
                    placeholder="例：1LDK以上"
                  />
                </Field>

                <Field label="担当者">
                  <input
                    className={INPUT}
                    value={form.assignee ?? ""}
                    onChange={(e) => setForm({ ...form, assignee: e.target.value })}
                    placeholder="例：竹内"
                  />
                </Field>
              </div>

              <Field label="こだわり">
                <textarea
                  className={INPUT + " h-16 resize-none"}
                  value={form.preferences ?? ""}
                  onChange={(e) => setForm({ ...form, preferences: e.target.value })}
                  placeholder="例：オートロック・独立洗面台"
                />
              </Field>

              <Field label="NGポイント">
                <textarea
                  className={INPUT + " h-16 resize-none"}
                  value={form.ng_points ?? ""}
                  onChange={(e) => setForm({ ...form, ng_points: e.target.value })}
                  placeholder="例：1階・南向き以外"
                />
              </Field>

              <Field label="物件候補メモ">
                <textarea
                  className={INPUT + " h-20 resize-none"}
                  value={form.property_memo ?? ""}
                  onChange={(e) => setForm({ ...form, property_memo: e.target.value })}
                  placeholder="例：〇〇マンション確認中・△△は送済み"
                />
              </Field>

              <Field label="電話番号">
                <input
                  className={INPUT}
                  value={form.phone ?? ""}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="例：090-1234-5678"
                />
              </Field>
            </div>

            {/* フッター */}
            <div className="px-5 py-4 border-t border-slate-100">
              <button
                onClick={save}
                disabled={saving}
                className="w-full bg-blue-700 text-white font-bold py-3 rounded-xl disabled:opacity-50"
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1 font-medium">{label}</label>
      {children}
    </div>
  );
}

const INPUT =
  "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none";
