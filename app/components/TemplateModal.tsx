"use client";

import { useEffect, useRef, useState } from "react";

interface Template {
  id: string;
  category: string;
  label: string;
  text: string;
  sort_order: number | null;
  requires_image: boolean;
}

interface TemplateModalProps {
  onClose: () => void;
  onSelect?: (text: string) => void;
  customerName?: string;
  conversationState?: string;
  recentMessages?: Array<{ sender: string; text: string; imageUrl?: string }>;
  linkedCustomer?: { id: string; name: string; conditions: string };
  initialCategory?: string;
}

export default function TemplateModal({
  onClose, onSelect, customerName, conversationState, recentMessages, linkedCustomer, initialCategory,
}: TemplateModalProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState(initialCategory || "全般");
  const [showAddForm, setShowAddForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState("全般");
  const [newText, setNewText] = useState("");
  const [newRequiresImage, setNewRequiresImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [adaptingId, setAdaptingId] = useState<string | null>(null);
  const [adaptedTexts, setAdaptedTexts] = useState<Record<string, string>>({});
  const [adaptErrors, setAdaptErrors] = useState<Record<string, string>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editText, setEditText] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editRequiresImage, setEditRequiresImage] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [noEmoji, setNoEmoji] = useState(false);
  const [templateImages, setTemplateImages] = useState<Record<string, File>>({});
  const [templateImagePreviews, setTemplateImagePreviews] = useState<Record<string, string>>({});
  const addFormRef = useRef<HTMLDivElement | null>(null);
  const templateImageInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/templates");
      const data = await res.json() as { ok: boolean; templates: Template[] };
      if (data.ok) {
        setTemplates(data.templates);
        const cats = Array.from(new Set(data.templates.map((t) => t.category)));
        if (cats.length > 0 && !cats.includes(category)) setCategory(cats[0]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTemplates(); }, []);

  useEffect(() => {
    if (showAddForm) setTimeout(() => addFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }, [showAddForm]);

  const categories = Array.from(new Set(templates.map((t) => t.category)));
  const isSearching = searchQuery.trim().length > 0;
  const filtered = isSearching
    ? templates.filter((t) =>
        t.label.includes(searchQuery) || t.text.includes(searchQuery) || t.category.includes(searchQuery)
      )
    : templates.filter((t) => t.category === category);

  const handleAdd = async () => {
    if (!newLabel.trim() || !newText.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: newCategory || "全般", label: newLabel, text: newText, requires_image: newRequiresImage }),
      });
      const data = await res.json() as { ok: boolean };
      if (data.ok) {
        setNewLabel(""); setNewText(""); setNewCategory("全般"); setNewRequiresImage(false); setShowAddForm(false);
        await loadTemplates();
      }
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (tmpl: Template) => {
    setEditingId(tmpl.id);
    setEditLabel(tmpl.label);
    setEditText(tmpl.text);
    setEditCategory(tmpl.category);
    setEditRequiresImage(tmpl.requires_image);
    setConfirmDeleteId(null);
  };

  const handleUpdate = async () => {
    if (!editingId || !editLabel.trim() || !editText.trim()) return;
    setEditSaving(true);
    try {
      const res = await fetch("/api/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, category: editCategory || "全般", label: editLabel, text: editText, requires_image: editRequiresImage }),
      });
      const data = await res.json() as { ok: boolean };
      if (data.ok) {
        setEditingId(null);
        await loadTemplates();
      }
    } finally {
      setEditSaving(false);
    }
  };

  const handleReorder = async (index: number, direction: "up" | "down") => {
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= filtered.length) return;

    const a = filtered[index];
    const b = filtered[swapIndex];
    const aOrder = a.sort_order ?? index;
    const bOrder = b.sort_order ?? swapIndex;

    setTemplates((prev) =>
      prev.map((t) =>
        t.id === a.id ? { ...t, sort_order: bOrder } :
        t.id === b.id ? { ...t, sort_order: aOrder } : t
      )
    );

    await fetch("/api/templates", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: [{ id: a.id, sort_order: bOrder }, { id: b.id, sort_order: aOrder }] }),
    });
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await fetch(`/api/templates?id=${id}`, { method: "DELETE" });
      setTemplates((prev) => {
        const next = prev.filter((t) => t.id !== id);
        const cats = Array.from(new Set(next.map((t) => t.category)));
        if (cats.length > 0 && !cats.includes(category)) setCategory(cats[0]);
        return next;
      });
      setConfirmDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  };

  const handleAdapt = async (tmpl: Template) => {
    setAdaptingId(tmpl.id);
    setAdaptErrors((prev) => { const n = { ...prev }; delete n[tmpl.id]; return n; });
    try {
      const res = await fetch("/api/templates/adapt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateText: tmpl.text,
          customerName,
          conversationState,
          recentMessages,
          customerConditions: linkedCustomer?.conditions,
          noEmoji,
        }),
      });
      const data = await res.json() as { ok: boolean; adapted?: string; error?: string };
      if (data.ok && data.adapted) {
        setAdaptedTexts((prev) => ({ ...prev, [tmpl.id]: data.adapted! }));
      } else {
        setAdaptErrors((prev) => ({ ...prev, [tmpl.id]: data.error || "AI最適化に失敗しました" }));
      }
    } catch {
      setAdaptErrors((prev) => ({ ...prev, [tmpl.id]: "通信エラーが発生しました" }));
    } finally {
      setAdaptingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-t-3xl bg-white shadow-2xl flex flex-col" style={{ maxHeight: "90vh" }}>
        {/* ヘッダー */}
        <div
          className="flex items-center justify-between rounded-t-3xl px-5 py-4 shrink-0"
          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
        >
          <div className="text-[17px] font-bold text-white">テンプレート一覧</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowAddForm((v) => !v); setNewCategory(category); }}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/25 text-white text-lg font-bold"
              title="新規テンプレートを追加"
            >
              ＋
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white"
            >
              ✕
            </button>
          </div>
        </div>
        {/* 検索欄 */}
        <div className="px-4 py-2 bg-white border-b border-[#f0f2f5] shrink-0">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="🔍 テンプレートを検索..."
            className="w-full rounded-full border border-[#d1d7db] px-4 py-1.5 text-[12px] outline-none focus:border-[#2196F3] bg-[#f8f9fa]"
          />
        </div>

        {/* カテゴリタブ（検索中は非表示） */}
        {!showAddForm && !isSearching && (
          <div className="flex gap-1.5 overflow-x-auto border-b border-[#f0f2f5] bg-white px-4 py-2.5 shrink-0">
            {categories.length === 0 && !loading && (
              <span className="text-[12px] text-[#aaa] py-1">カテゴリなし（テンプレートを追加してください）</span>
            )}
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition"
                style={
                  category === cat
                    ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white" }
                    : { backgroundColor: "#f0f2f5", color: "#54656f" }
                }
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* スクロール領域 */}
        <div className="flex-1 overflow-y-auto">

          {/* 新規追加フォーム */}
          {showAddForm && (
            <div ref={addFormRef} className="p-4 border-b border-[#f0f2f5] bg-[#f8f9fa]">
              <div className="text-[13px] font-bold text-[#1565C0] mb-3">新しいテンプレートを追加</div>
              <div className="flex flex-col gap-2.5">
                <div>
                  <div className="text-[11px] text-[#667781] mb-1">カテゴリ</div>
                  <div className="flex gap-2 flex-wrap">
                    {["全般", "初回応対", "物件探し中", "内覧", "申込・審査", "契約・成約", "その他"].map((c) => (
                      <button
                        key={c}
                        onClick={() => setNewCategory(c)}
                        className="rounded-full px-3 py-1 text-[11px] font-bold border transition"
                        style={
                          newCategory === c
                            ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white", borderColor: "transparent" }
                            : { backgroundColor: "white", color: "#54656f", borderColor: "#d1d7db" }
                        }
                      >
                        {c}
                      </button>
                    ))}
                    <input
                      className="rounded-full border border-[#d1d7db] px-3 py-1 text-[11px] outline-none w-32"
                      placeholder="カテゴリ名を入力"
                      value={["全般","初回応対","物件探し中","内覧","申込・審査","契約・成約","その他"].includes(newCategory) ? "" : newCategory}
                      onChange={(e) => setNewCategory(e.target.value || "全般")}
                    />
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-[#667781] mb-1">テンプレート名</div>
                  <input
                    className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                    placeholder="例：内覧お誘い"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                  />
                </div>
                <div>
                  <div className="text-[11px] text-[#667781] mb-1">テンプレート本文</div>
                  <textarea
                    className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3] resize-none"
                    rows={5}
                    placeholder="LINEで送るテンプレート文を入力..."
                    value={newText}
                    onChange={(e) => setNewText(e.target.value)}
                  />
                </div>
                <button
                  onClick={() => setNewRequiresImage(v => !v)}
                  className={`w-full rounded-xl border py-2 text-[12px] font-bold transition ${newRequiresImage ? "border-orange-400 bg-orange-50 text-orange-600" : "border-[#d1d7db] bg-white text-[#54656f]"}`}
                >
                  📸 {newRequiresImage ? "画像添付必要（オン）" : "画像添付必要（オフ）"}
                </button>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setShowAddForm(false); setNewLabel(""); setNewText(""); setNewCategory("全般"); setNewRequiresImage(false); }}
                    className="rounded-full px-4 py-2 text-[12px] font-bold text-[#667781] border border-[#d1d7db]"
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleAdd}
                    disabled={saving || !newLabel.trim() || !newText.trim()}
                    className="rounded-full px-5 py-2 text-[12px] font-bold text-white disabled:opacity-50"
                    style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
                  >
                    {saving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* テンプレート一覧 */}
          {!showAddForm && (
            <div className="p-4">
              {!loading && filtered.length > 0 && (
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className={`flex-1 flex items-center gap-1.5 rounded-xl px-3 py-2 ${linkedCustomer ? "bg-emerald-50 border border-emerald-200" : "bg-amber-50 border border-amber-200"}`}>
                    <span className={`text-[11px] ${linkedCustomer ? "text-emerald-700" : "text-amber-700"}`}>
                      {linkedCustomer ? `🔗 ${linkedCustomer.name}さんの希望条件で最適化します` : "👤 お客様を紐付けると駅名・間取りが自動で合わせられます"}
                    </span>
                  </div>
                  <div className="flex rounded-full border border-[#d1d7db] overflow-hidden text-[10px] font-bold shrink-0">
                    <button
                      onClick={() => setNoEmoji(false)}
                      className={`px-2.5 py-1 transition-colors ${!noEmoji ? "bg-[#1565C0] text-white" : "bg-white text-[#888]"}`}
                    >絵文字あり</button>
                    <button
                      onClick={() => setNoEmoji(true)}
                      className={`px-2.5 py-1 transition-colors ${noEmoji ? "bg-[#1565C0] text-white" : "bg-white text-[#888]"}`}
                    >絵文字なし</button>
                  </div>
                </div>
              )}
              {loading ? (
                <div className="py-8 text-center text-[13px] text-[#aaa]">読み込み中...</div>
              ) : filtered.length === 0 ? (
                <div className="py-8 text-center">
                  <div className="text-[13px] text-[#aaa] mb-3">このカテゴリにテンプレートがありません</div>
                  <button
                    onClick={() => setShowAddForm(true)}
                    className="rounded-full px-4 py-2 text-[12px] font-bold text-white"
                    style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
                  >
                    ＋ 追加する
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {filtered.map((tmpl, idx) => {
                    const adapted = adaptedTexts[tmpl.id];
                    const displayText = adapted || tmpl.text;
                    return (
                      <div key={tmpl.id} className="rounded-2xl border border-[#e9edef] bg-[#f8f9fa] p-4">
                        {/* タイトル行 */}
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-[#1565C0] flex-1 min-w-0 truncate">{tmpl.label}</span>
                          {isSearching && (
                            <span className="shrink-0 rounded-full bg-[#e8f0fe] px-2 py-0.5 text-[10px] font-bold text-[#1565C0]">{tmpl.category}</span>
                          )}
                          {tmpl.requires_image && (
                            <span className="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-600">📸 画像必要</span>
                          )}
                          {editingId !== tmpl.id && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() => handleReorder(idx, "up")}
                                disabled={idx === 0}
                                className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-[#bbb] hover:text-[#1565C0] disabled:opacity-20 transition"
                                title="上へ"
                              >↑</button>
                              <button
                                onClick={() => handleReorder(idx, "down")}
                                disabled={idx === filtered.length - 1}
                                className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-[#bbb] hover:text-[#1565C0] disabled:opacity-20 transition"
                                title="下へ"
                              >↓</button>
                              <div className="w-px h-3 bg-[#e0e0e0] mx-0.5" />
                              <button
                                onClick={() => startEdit(tmpl)}
                                className="text-[11px] text-[#aaa] hover:text-[#1565C0] transition font-medium"
                              >編集</button>
                              <button
                                onClick={() => setConfirmDeleteId(tmpl.id)}
                                className="text-[11px] text-[#ccc] hover:text-red-400 transition font-medium"
                              >削除</button>
                            </div>
                          )}
                        </div>

                        {/* インライン編集フォーム */}
                        {editingId === tmpl.id ? (
                          <div className="flex flex-col gap-2">
                            {/* カテゴリ変更 */}
                            <div className="flex gap-1.5 flex-wrap">
                              {["全般", "初回応対", "物件探し中", "内覧", "申込・審査", "契約・成約", "その他", ...categories.filter(c => !["全般","初回応対","物件探し中","内覧","申込・審査","契約・成約","その他"].includes(c))].map((c) => (
                                <button
                                  key={c}
                                  onClick={() => setEditCategory(c)}
                                  className="rounded-full px-2.5 py-1 text-[10px] font-bold border transition"
                                  style={editCategory === c ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white", border: "none" } : { backgroundColor: "#f0f2f5", color: "#54656f", borderColor: "#d1d7db" }}
                                >{c}</button>
                              ))}
                            </div>
                            <input
                              className="w-full rounded-xl border border-[#b3d0f7] px-3 py-2 text-[12px] outline-none focus:border-[#2196F3]"
                              value={editLabel}
                              onChange={(e) => setEditLabel(e.target.value)}
                              placeholder="テンプレート名"
                            />
                            <textarea
                              className="w-full rounded-xl border border-[#b3d0f7] px-3 py-2 text-[12px] outline-none focus:border-[#2196F3] resize-none"
                              rows={5}
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              placeholder="本文"
                            />
                            <button
                              onClick={() => setEditRequiresImage(v => !v)}
                              className={`w-full rounded-xl border py-1.5 text-[11px] font-bold transition ${editRequiresImage ? "border-orange-400 bg-orange-50 text-orange-600" : "border-[#d1d7db] bg-white text-[#54656f]"}`}
                            >📸 {editRequiresImage ? "画像添付必要（オン）" : "画像添付必要（オフ）"}</button>
                            <div className="flex gap-2 justify-end mt-1">
                              <button
                                onClick={() => setEditingId(null)}
                                className="rounded-full px-3 py-1.5 text-[11px] font-bold text-[#667781] border border-[#d1d7db]"
                              >キャンセル</button>
                              <button
                                onClick={handleUpdate}
                                disabled={editSaving || !editLabel.trim() || !editText.trim()}
                                className="rounded-full px-4 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                                style={{ background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }}
                              >{editSaving ? "保存中..." : "保存"}</button>
                            </div>
                          </div>
                        ) : (
                          <>
                        {/* 削除確認 */}
                        {confirmDeleteId === tmpl.id && (
                          <div className="mb-2 flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
                            <span className="text-[12px] text-red-600 flex-1">削除しますか？</span>
                            <button
                              onClick={() => handleDelete(tmpl.id)}
                              disabled={deletingId === tmpl.id}
                              className="rounded-full px-3 py-1 text-[11px] font-bold text-white bg-red-500 disabled:opacity-50"
                            >
                              {deletingId === tmpl.id ? "..." : "削除"}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-full px-3 py-1 text-[11px] font-bold text-[#667781] border border-[#d1d7db]"
                            >
                              戻る
                            </button>
                          </div>
                        )}

                        {/* AI最適化エラー */}
                        {adaptErrors[tmpl.id] && (
                          <div className="mb-1.5 flex items-center gap-1 rounded-xl bg-red-50 border border-red-200 px-2 py-1">
                            <span className="text-[10px] text-red-600">⚠️ {adaptErrors[tmpl.id]}</span>
                            <button
                              onClick={() => setAdaptErrors((p) => { const n = { ...p }; delete n[tmpl.id]; return n; })}
                              className="ml-auto text-[10px] text-[#aaa] underline"
                            >
                              閉じる
                            </button>
                          </div>
                        )}

                        {/* AI最適化済みバッジ */}
                        {adapted && (
                          <div className="mb-1.5 flex items-center gap-1">
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">✨ AIで最適化済み</span>
                            <button
                              onClick={() => setAdaptedTexts((p) => { const n = { ...p }; delete n[tmpl.id]; return n; })}
                              className="text-[10px] text-[#aaa] underline"
                            >
                              元に戻す
                            </button>
                          </div>
                        )}

                        {/* 本文 */}
                        <p className="whitespace-pre-wrap text-[13px] leading-5 text-[#111b21] mb-3">{displayText}</p>
                        </>
                        )}

                        {/* 画像必要テンプレ: 画像ピッカー */}
                        {editingId !== tmpl.id && tmpl.requires_image && (
                          <div className="mb-3">
                            {templateImagePreviews[tmpl.id] ? (
                              <div className="relative overflow-hidden rounded-xl border border-orange-200">
                                <img src={templateImagePreviews[tmpl.id]} className="max-h-28 w-full object-contain" alt="添付画像" />
                                <button
                                  onClick={() => {
                                    setTemplateImages(prev => { const n = { ...prev }; delete n[tmpl.id]; return n; });
                                    setTemplateImagePreviews(prev => { const n = { ...prev }; delete n[tmpl.id]; return n; });
                                  }}
                                  className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white"
                                >変更</button>
                              </div>
                            ) : (
                              <button
                                onClick={() => templateImageInputRefs.current[tmpl.id]?.click()}
                                className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-orange-300 py-3 text-[11px] font-bold text-orange-500 bg-orange-50"
                              >📸 物件資料画像を添付（必須）</button>
                            )}
                            <input
                              type="file" accept="image/*" className="hidden"
                              ref={el => { templateImageInputRefs.current[tmpl.id] = el; }}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (!f) return;
                                setTemplateImages(prev => ({ ...prev, [tmpl.id]: f }));
                                const reader = new FileReader();
                                reader.onload = () => setTemplateImagePreviews(prev => ({ ...prev, [tmpl.id]: String(reader.result ?? "") }));
                                reader.readAsDataURL(f);
                              }}
                            />
                          </div>
                        )}

                        {/* ボタン行 */}
                        {editingId !== tmpl.id && <div className="flex items-center gap-2 flex-wrap">
                          {onSelect && (
                            <button
                              onClick={() => {
                                if (tmpl.requires_image && !templateImages[tmpl.id]) {
                                  alert("📸 物件資料画像を添付してください");
                                  return;
                                }
                                onSelect(displayText);
                                onClose();
                              }}
                              className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white"
                              style={{ background: "linear-gradient(135deg, #06c755, #06a043)" }}
                            >
                              そのまま使う
                            </button>
                          )}
                          <button
                            onClick={() => handleAdapt(tmpl)}
                            disabled={adaptingId === tmpl.id}
                            className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50 flex items-center gap-1"
                            style={{ background: "linear-gradient(135deg, #f59e0b, #d97706)" }}
                          >
                            {adaptingId === tmpl.id ? (
                              <>
                                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                                最適化中...
                              </>
                            ) : (
                              <>
                                ✨ AIで最適化
                                {linkedCustomer && (
                                  <span className="ml-1 rounded-full bg-white/30 px-1.5 py-0.5 text-[9px] font-bold">👤条件あり</span>
                                )}
                              </>
                            )}
                          </button>
                          {adapted && onSelect && (
                            <button
                              onClick={() => { onSelect(adapted); onClose(); }}
                              className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white"
                              style={{ background: "linear-gradient(135deg, #06c755, #06a043)" }}
                            >
                              最適化版を使う
                            </button>
                          )}
                        </div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
