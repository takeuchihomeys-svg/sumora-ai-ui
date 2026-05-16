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

const STATUS_COLORS: Record<Status, string> = {
  first_reply: "bg-purple-100 text-purple-700",
  condition_hearing: "bg-blue-100 text-blue-700",
  property_search: "bg-cyan-100 text-cyan-700",
  property_recommendation: "bg-green-100 text-green-700",
  viewing: "bg-orange-100 text-orange-700",
  application: "bg-rose-100 text-rose-700",
};

const PRIORITY_BAR: Record<Priority, string> = {
  urgent: "bg-red-500",
  normal: "bg-yellow-400",
  done: "bg-gray-300",
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

    const payload = { ...form, max_rent: form.max_rent || null };

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

  const filtered =
    filter === "all" ? customers : customers.filter((c) => c.priority === filter);

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ヘッダー */}
      <header className="sticky top-0 z-20 bg-blue-700 text-white shadow-md">
        <div className="px-4 pt-3 pb-2 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold leading-tight">物件条件管理</h1>
            <p className="text-xs text-blue-200">
              {filtered.length}件表示 / 全{customers.length}件
            </p>
          </div>
          <button
            onClick={openAdd}
            className="bg-white text-blue-700 font-bold text-sm px-4 py-2 rounded-lg shadow"
          >
            ＋ 新規追加
          </button>
        </div>

        {/* フィルタータブ */}
        <div className="flex gap-1.5 px-4 pb-3 overflow-x-auto">
          {(["all", "urgent", "normal", "done"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setFilter(p)}
              className={`whitespace-nowrap px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                filter === p
                  ? "bg-white text-blue-700"
                  : "bg-blue-600/70 text-blue-100"
              }`}
            >
              {p === "all" ? "全て" : PRIORITY_LABELS[p]}
            </button>
          ))}
        </div>
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

      {/* リスト */}
      <div className="mt-2">
        {loading ? (
          <p className="text-center text-gray-400 py-16 text-sm">読み込み中...</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-400 text-sm">
              {filter === "all" ? "お客様がいません" : "該当するお客様がいません"}
            </p>
            <button
              onClick={openAdd}
              className="mt-4 text-blue-600 text-sm underline"
            >
              ＋ 新規追加
            </button>
          </div>
        ) : (
          <div className="bg-white border-t border-b border-gray-200 divide-y divide-gray-100">
            {filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => openEdit(c)}
                className="w-full text-left flex items-stretch hover:bg-blue-50 active:bg-blue-100 transition-colors"
              >
                {/* 優先度バー */}
                <div className={`w-1 flex-shrink-0 ${PRIORITY_BAR[c.priority]}`} />

                {/* コンテンツ */}
                <div className="flex-1 px-3 py-3 min-w-0">
                  {/* 1行目: 名前 + ステータスバッジ */}
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-bold text-gray-900 text-sm">
                      {c.customer_name}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        STATUS_COLORS[c.status] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {STATUS_LABELS[c.status] ?? c.status}
                    </span>
                  </div>

                  {/* 2行目: 条件サマリー */}
                  <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                    {c.area && <span>📍 {c.area}</span>}
                    {c.max_rent && (
                      <span>💴 {c.max_rent.toLocaleString()}円</span>
                    )}
                    {c.layout && <span>🏠 {c.layout}</span>}
                    {!c.area && !c.max_rent && !c.layout && (
                      <span className="text-gray-300">条件未設定</span>
                    )}
                  </div>

                  {/* 3行目: 担当者 + メモ */}
                  {(c.assignee || c.property_memo) && (
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                      {c.assignee && <span>👤 {c.assignee}</span>}
                      {c.property_memo && (
                        <span className="truncate max-w-[200px]">
                          📝 {c.property_memo}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* 右矢印 */}
                <div className="flex items-center pr-3 text-gray-300">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
              </button>
            ))}
          </div>
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
          <div className="w-full max-w-lg bg-white rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col">
            {/* モーダルヘッダー */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-800">
                {editTarget ? "お客様情報を編集" : "新規お客様追加"}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-400 text-2xl leading-none"
              >
                ×
              </button>
            </div>

            {/* フォーム */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {error && (
                <p className="text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <Field label="お客様名 *">
                <input
                  className={INPUT}
                  value={form.customer_name}
                  onChange={(e) =>
                    setForm({ ...form, customer_name: e.target.value })
                  }
                  placeholder="例：田中 太郎"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="対応優先度">
                  <select
                    className={INPUT}
                    value={form.priority}
                    onChange={(e) =>
                      setForm({ ...form, priority: e.target.value as Priority })
                    }
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
                    onChange={(e) =>
                      setForm({ ...form, status: e.target.value as Status })
                    }
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
                    onChange={(e) =>
                      setForm({ ...form, area: e.target.value })
                    }
                    placeholder="例：梅田 徒歩10分"
                  />
                </Field>

                <Field label="賃料上限（円）">
                  <input
                    className={INPUT}
                    type="number"
                    value={form.max_rent ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        max_rent: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
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
                    onChange={(e) =>
                      setForm({ ...form, layout: e.target.value })
                    }
                    placeholder="例：1LDK以上"
                  />
                </Field>

                <Field label="担当者">
                  <input
                    className={INPUT}
                    value={form.assignee ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, assignee: e.target.value })
                    }
                    placeholder="例：竹内"
                  />
                </Field>
              </div>

              <Field label="こだわり">
                <textarea
                  className={INPUT + " h-16 resize-none"}
                  value={form.preferences ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, preferences: e.target.value })
                  }
                  placeholder="例：オートロック・独立洗面台"
                />
              </Field>

              <Field label="NGポイント">
                <textarea
                  className={INPUT + " h-16 resize-none"}
                  value={form.ng_points ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, ng_points: e.target.value })
                  }
                  placeholder="例：1階・南向き以外"
                />
              </Field>

              <Field label="物件候補メモ">
                <textarea
                  className={INPUT + " h-20 resize-none"}
                  value={form.property_memo ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, property_memo: e.target.value })
                  }
                  placeholder="例：〇〇マンション確認中・△△は送済み"
                />
              </Field>

              <Field label="電話番号">
                <input
                  className={INPUT}
                  value={form.phone ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, phone: e.target.value })
                  }
                  placeholder="例：090-1234-5678"
                />
              </Field>

              {editTarget && (
                <button
                  onClick={() => deleteCustomer(editTarget.id)}
                  className="w-full text-red-500 text-sm py-2 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                >
                  このお客様を削除
                </button>
              )}
            </div>

            {/* フッター */}
            <div className="px-5 py-4 border-t border-gray-100">
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1 font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

const INPUT =
  "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none";
