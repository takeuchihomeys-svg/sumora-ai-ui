"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// iOS風スクロールホイールピッカー
function WheelPicker({ items, selectedIdx, onSelect }: {
  items: string[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ITEM_H = 36;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = selectedIdx * ITEM_H;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settle = useCallback(() => {
    if (!ref.current) return;
    const idx = Math.round(ref.current.scrollTop / ITEM_H);
    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    ref.current.scrollTo({ top: clamped * ITEM_H, behavior: "smooth" });
    onSelect(clamped);
  }, [items.length, onSelect]);

  const handleScroll = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(settle, 200);
  };

  return (
    <div className="relative overflow-hidden" style={{ height: ITEM_H * 3 }}>
      <div className="pointer-events-none absolute inset-x-1" style={{ top: ITEM_H, height: ITEM_H, background: "rgba(21,101,192,0.08)", borderRadius: 8, borderTop: "1px solid #b3d9f7", borderBottom: "1px solid #b3d9f7" }} />
      <div
        ref={ref}
        onScroll={handleScroll}
        style={{ height: ITEM_H * 3, overflowY: "scroll", scrollSnapType: "y mandatory", scrollbarWidth: "none" }}
      >
        <div style={{ height: ITEM_H }} />
        {items.map((item, i) => (
          <div key={i} style={{ height: ITEM_H, scrollSnapAlign: "center" }} className={`flex items-center justify-center text-[14px] ${i === selectedIdx ? "font-bold text-[#1565C0]" : "text-[#aaa]"}`}>
            {item}
          </div>
        ))}
        <div style={{ height: ITEM_H }} />
      </div>
    </div>
  );
}

function lastDayOfMonth(month: number) {
  return new Date(new Date().getFullYear(), month, 0).getDate();
}

// 退去予定日ピッカー（月＋日の2カラム）
function VacatingDatePicker({ value, onChange }: {
  value: { month: number; day: number } | null;
  onChange: (date: { month: number; day: number } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentMonth = new Date().getMonth() + 1;
  const [selMonth, setSelMonth] = useState(value?.month ?? currentMonth);
  const [selDay, setSelDay]   = useState(value?.day   ?? 1);

  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
  const maxDay = lastDayOfMonth(selMonth);
  const days   = Array.from({ length: maxDay }, (_, i) => {
    const d = i + 1;
    return d === maxDay ? `${d}日（末日）` : `${d}日`;
  });

  const handleMonthSelect = (idx: number) => {
    const m = idx + 1;
    setSelMonth(m);
    const max = lastDayOfMonth(m);
    if (selDay > max) setSelDay(max);
  };

  const handleConfirm = () => {
    onChange({ month: selMonth, day: selDay });
    setOpen(false);
  };

  const displayValue = value
    ? `${value.month}月${value.day >= lastDayOfMonth(value.month) ? "末日" : `${value.day}日`}`
    : null;

  return (
    <div className="mb-3 rounded-xl border border-[#e0e8ff] bg-[#f0f5ff] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold text-[#5c6bc0]">退去予定日</span>
        {displayValue ? (
          <>
            <span className="text-[12px] font-bold text-[#1565C0]">{displayValue}</span>
            <button onClick={() => onChange(null)} className="text-[10px] text-[#aaa] underline">クリア</button>
          </>
        ) : (
          <span className="text-[10px] text-[#aaa]">未設定（日付なしで生成）</span>
        )}
        <button
          onClick={() => setOpen(v => !v)}
          className="ml-auto shrink-0 rounded-full bg-[#1565C0] px-2.5 py-0.5 text-[10px] font-bold text-white active:opacity-70"
        >{open ? "閉じる" : "設定"}</button>
      </div>

      {open && (
        <div className="mt-2 overflow-hidden rounded-xl border border-[#d0d8f7] bg-white">
          <div className="flex">
            <div className="flex-1 border-r border-[#e0e8f7]">
              <WheelPicker items={months} selectedIdx={selMonth - 1} onSelect={handleMonthSelect} />
            </div>
            <div className="flex-1">
              <WheelPicker key={selMonth} items={days} selectedIdx={Math.min(selDay - 1, days.length - 1)} onSelect={(i) => setSelDay(i + 1)} />
            </div>
          </div>
          <div className="flex border-t border-[#e0e8f7]">
            <button onClick={() => setOpen(false)} className="flex-1 py-2 text-[12px] text-[#aaa]">キャンセル</button>
            <button onClick={handleConfirm} className="flex-1 border-l border-[#e0e8f7] py-2 text-[12px] font-bold text-[#1565C0]">決定</button>
          </div>
        </div>
      )}
    </div>
  );
}

type StructureBlock = { label: string; text: string };

interface Template {
  id: string;
  category: string;
  label: string;
  text: string;
  structure: StructureBlock[] | null;
  sort_order: number | null;
  requires_image: boolean;
}

interface TemplateModalProps {
  onClose: () => void;
  onSelect?: (text: string, imageFiles?: File[], label?: string, category?: string) => void;
  onOpenAixWithFocus?: (focusPoints: string[], templateInfo?: { name: string; category: string; structure?: Array<{ label: string; text: string }>; sample?: string }) => void;
  customerName?: string;
  conversationState?: string;
  recentMessages?: Array<{ sender: string; text: string; imageUrl?: string }>;
  linkedCustomer?: { id: string; name: string; conditions: string };
  initialCategory?: string;
  highlightKeyword?: string;
  highlightLabel?: string;
  // 予約送信待ちのAIXメッセージ（物件情報の読み取り元）
  pendingScheduledMessages?: Array<{ text: string | null }>;
  // 今日スタッフがすでに送信済みか（挨拶切り替えに使用）
  staffMessagedToday?: boolean;
}

export default function TemplateModal({
  onClose, onSelect, onOpenAixWithFocus, customerName, conversationState, recentMessages, linkedCustomer, initialCategory, highlightKeyword, highlightLabel, pendingScheduledMessages, staffMessagedToday,
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
  const [editStructure, setEditStructure] = useState<StructureBlock[]>([]);
  const [structureViewId, setStructureViewId] = useState<string | null>(null);
  const [sampleViewIds, setSampleViewIds] = useState<Set<string>>(new Set());
  const [editSaving, setEditSaving] = useState(false);
  const [noEmoji, setNoEmoji] = useState(false);
  const [aixPurposeFilter, setAixPurposeFilter] = useState<"内覧" | "申込">("内覧");
  const [vacatingDates, setVacatingDates] = useState<Record<string, { month: number; day: number } | null>>({});
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [templateImages, setTemplateImages] = useState<Record<string, File[]>>({});
  const [templateImagePreviews, setTemplateImagePreviews] = useState<Record<string, string[]>>({});
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [extractedTexts, setExtractedTexts] = useState<Record<string, string>>({});
  const [extractErrors, setExtractErrors] = useState<Record<string, string>>({});
  const addFormRef = useRef<HTMLDivElement | null>(null);
  const templateImageInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const categoryTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const categoryScrollRef = useRef<HTMLDivElement | null>(null);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const categoryEditInputRef = useRef<HTMLInputElement | null>(null);
  // AIXカテゴリ: テンプレートカードごとの訴求ポイント選択状態
  const [focusPointsMap, setFocusPointsMap] = useState<Record<string, string[]>>({});
  const [soloEntry, setSoloEntry] = useState(false);

  function applyVacatingDates(text: string, vd: { month: number; day: number } | null): string {
    const lastDayOf = (m: number) => new Date(new Date().getFullYear(), m, 0).getDate();
    const C = '[◯○〇]';
    let t = text;
    let vacStr: string | null = null;
    let viewStr: string | null = null;
    if (vd) {
      const vacDay = Math.min(vd.day, lastDayOf(vd.month));
      vacStr = `${vd.month}月${vacDay}日`;
      let vm = vd.month; let vday = vacDay + 1;
      if (vday > lastDayOf(vm)) { vday = 1; vm = vm === 12 ? 1 : vm + 1; }
      viewStr = `${vm}月${vday}日`;
    }
    t = t.replace(new RegExp(`${C}+月${C}+日退去の為${C}+月${C}+日以降ご内覧可能`, 'g'),
      vacStr && viewStr ? `${vacStr}退去の為${viewStr}以降ご内覧可能` : '退去の為内覧可能日以降ご内覧可能');
    t = t.replace(new RegExp(`${C}+月${C}+退去予定の為${C}+月${C}+日以降ご内覧可能`, 'g'),
      vacStr && viewStr ? `${vacStr}退去予定の為${viewStr}以降ご内覧可能` : '退去予定の為内覧可能日以降ご内覧可能');
    t = t.replace(new RegExp(`${C}+月${C}+日以降ご内覧可能`, 'g'),
      viewStr ? `${viewStr}以降ご内覧可能` : '内覧可能日以降ご内覧可能');
    t = t.replace(new RegExp(`${C}+月${C}+日退去予定`, 'g'),
      vacStr ? `${vacStr}退去予定` : '退去予定');
    return t;
  }

  function applySoloEntry(text: string): string {
    const SOLO_RE = /同居人|配偶者|同居者|家族構成|入居人数|お子様|子ども|子供|同居|ご家族/;
    return text
      .split("\n")
      .filter(line => !SOLO_RE.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function highlightTemplateVars(text: string): React.ReactNode[] {
    const parts = text.split(/(アカウント名|〇〇|○○)/g);
    return parts.map((part, i) => {
      if (part === "アカウント名") return <mark key={i} className="bg-orange-100 text-orange-700 rounded px-0.5 font-bold not-italic">アカウント名</mark>;
      if (part === "〇〇" || part === "○○") return <mark key={i} className="bg-sky-100 text-sky-700 rounded px-0.5 font-bold not-italic">{part}</mark>;
      return <span key={i}>{part}</span>;
    });
  }

  function detectTemplateElements(text: string): { emoji: string; label: string; bg: string; fg: string }[] {
    const el: { emoji: string; label: string; bg: string; fg: string }[] = [];
    if (/🌟|⭐|【新築|【物件/.test(text)) el.push({ emoji: "🌟", label: "物件名", bg: "bg-amber-100", fg: "text-amber-800" });
    if (/内覧.*?(?:できません|出来ません|未完成|完成前|予定)|現在内覧/.test(text)) el.push({ emoji: "🚧", label: "内覧不可フォロー（突っ込まれ防止）", bg: "bg-orange-100", fg: "text-orange-800" });
    else if (/内覧|ご案内/.test(text)) el.push({ emoji: "🏠", label: "内覧誘導", bg: "bg-blue-100", fg: "text-blue-800" });
    if (/条件|ご希望/.test(text)) el.push({ emoji: "✅", label: "条件一致アピール", bg: "bg-emerald-100", fg: "text-emerald-800" });
    if (/家賃|万円|[0-9]円/.test(text)) el.push({ emoji: "💴", label: "家賃・費用訴求", bg: "bg-green-100", fg: "text-green-800" });
    if (/徒歩[0-9]|[0-9]分|駅.*徒歩/.test(text)) el.push({ emoji: "🚃", label: "アクセス訴求", bg: "bg-sky-100", fg: "text-sky-800" });
    if (/新築|築浅/.test(text)) el.push({ emoji: "🏗️", label: "新築・築浅訴求", bg: "bg-teal-100", fg: "text-teal-800" });
    if (/申込|仮押さえ/.test(text)) el.push({ emoji: "📝", label: "申込誘導", bg: "bg-purple-100", fg: "text-purple-800" });
    if (/潜在|意識/.test(text)) el.push({ emoji: "🧠", label: "潜在意識への訴求", bg: "bg-violet-100", fg: "text-violet-800" });
    return el;
  }

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
  useEffect(() => { setSoloEntry(false); }, [category]);

  const commitCategoryRename = async () => {
    const oldCat = editingCategory;
    const newCat = editingCategoryName.trim();
    setEditingCategory(null);
    if (!oldCat || !newCat || oldCat === newCat) return;
    await fetch("/api/templates/rename-category", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldCategory: oldCat, newCategory: newCat }),
    });
    setTemplates(prev => prev.map(t => t.category === oldCat ? { ...t, category: newCat } : t));
    setCategory(newCat);
  };

  useEffect(() => {
    if (showAddForm) setTimeout(() => addFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }, [showAddForm]);

  useEffect(() => {
    if (!category) return;
    setTimeout(() => {
      const btn = categoryTabRefs.current[category];
      const container = categoryScrollRef.current;
      if (btn && container) {
        const offset = btn.offsetLeft - 16;
        container.scrollTo({ left: Math.max(0, offset), behavior: "smooth" });
      }
    }, 80);
  }, [category]);

  const categories = Array.from(new Set(templates.map((t) => t.category)));
  const isSearching = searchQuery.trim().length > 0;
  const filtered = (isSearching
    ? templates.filter((t) =>
        t.label.includes(searchQuery) || t.text.includes(searchQuery) || t.category.includes(searchQuery)
      )
    : templates.filter((t) => t.category === category)
  ).sort((a, b) => (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER));

  const isAixCategory = category === "物件オススメ【AIX】" && !isSearching;
  const displayFiltered = isAixCategory
    ? filtered.filter(t => {
        const els = detectTemplateElements(t.text);
        if (aixPurposeFilter === "内覧") return els.some(e => e.label === "内覧誘導");
        return els.some(e => e.label === "申込誘導");
      })
    : filtered;

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
    setEditStructure(tmpl.structure ?? []);
    setConfirmDeleteId(null);
  };

  const handleUpdate = async () => {
    if (!editingId || !editLabel.trim() || !editText.trim()) return;
    setEditSaving(true);
    try {
      const res = await fetch("/api/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, category: editCategory || "全般", label: editLabel, text: editText, structure: editStructure.length > 0 ? editStructure : null, requires_image: editRequiresImage }),
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
    // filtered はソート済みなのでインデックスに * 10 を掛けてスパースな値を確保
    const aOrder = a.sort_order ?? index * 10;
    const bOrder = b.sort_order ?? swapIndex * 10;

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
          soloEntry,
          // 予約送信待ちのAIXメッセージを渡す（物件情報の優先ソース）
          pendingScheduledMessages: (pendingScheduledMessages ?? []).filter(m => m.text),
          vacatingDate: vacatingDates[tmpl.id] ?? null,
          staffMessagedToday: staffMessagedToday ?? false,
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
          <div ref={categoryScrollRef} className="flex gap-1.5 overflow-x-auto border-b border-[#f0f2f5] bg-white px-4 py-2.5 shrink-0 scroll-smooth" style={{ scrollbarWidth: "none" }}>
            {categories.length === 0 && !loading && (
              <span className="text-[12px] text-[#aaa] py-1">カテゴリなし（テンプレートを追加してください）</span>
            )}
            {categories.map((cat) => (
              <div
                key={cat}
                ref={el => { categoryTabRefs.current[cat] = el as unknown as HTMLButtonElement; }}
                className="shrink-0 flex items-center rounded-full text-[11px] font-bold transition overflow-hidden"
                style={
                  category === cat
                    ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)", color: "white" }
                    : { backgroundColor: "#f0f2f5", color: "#54656f" }
                }
              >
                {editingCategory === cat ? (
                  <input
                    ref={categoryEditInputRef}
                    value={editingCategoryName}
                    onChange={e => setEditingCategoryName(e.target.value)}
                    onBlur={commitCategoryRename}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); void commitCategoryRename(); }
                      if (e.key === "Escape") { setEditingCategory(null); }
                    }}
                    className="bg-transparent outline-none min-w-[60px] max-w-[120px] px-3 py-1.5 text-[11px] font-bold"
                    style={{ color: "white" }}
                  />
                ) : (
                  <>
                    <button
                      onClick={() => setCategory(cat)}
                      className="pl-3 py-1.5 pr-1"
                    >{cat}</button>
                    <button
                      onClick={() => {
                        setCategory(cat);
                        setEditingCategory(cat);
                        setEditingCategoryName(cat);
                        setTimeout(() => { categoryEditInputRef.current?.select(); }, 20);
                      }}
                      className="pr-2 py-1.5 opacity-60 hover:opacity-100"
                      title="カテゴリ名を編集"
                    >✏️</button>
                  </>
                )}
              </div>
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
                  📎 {newRequiresImage ? "画像添付必要（オン）" : "画像添付必要（オフ）"}
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
                <div className="mb-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
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
                  {isAixCategory && (
                    <div className="flex justify-end">
                      <div className="flex rounded-full border border-[#d1d7db] overflow-hidden text-[10px] font-bold shrink-0">
                        <button
                          onClick={() => setAixPurposeFilter("内覧")}
                          className={`px-2.5 py-1 transition-colors ${aixPurposeFilter === "内覧" ? "bg-[#1565C0] text-white" : "bg-white text-[#888]"}`}
                        >内覧誘導</button>
                        <button
                          onClick={() => setAixPurposeFilter("申込")}
                          className={`px-2.5 py-1 transition-colors ${aixPurposeFilter === "申込" ? "bg-[#1565C0] text-white" : "bg-white text-[#888]"}`}
                        >申込誘導</button>
                      </div>
                    </div>
                  )}
                  {!isSearching && (category === "申込・審査" || displayFiltered.some(t => /同居人|配偶者/.test(t.text))) && (
                    <div className="flex justify-end">
                      <button
                        onClick={() => setSoloEntry(v => !v)}
                        className={`rounded-full px-3 py-1 text-[10px] font-bold border transition-colors ${soloEntry ? "bg-pink-500 text-white border-transparent shadow-sm" : "bg-white text-[#667781] border-[#d1d7db]"}`}
                      >
                        {soloEntry ? "✓ 1人入居モード" : "👤 1人入居"}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {loading ? (
                <div className="py-8 text-center text-[13px] text-[#aaa]">読み込み中...</div>
              ) : displayFiltered.length === 0 ? (
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
                  {displayFiltered.map((tmpl) => {
                    const idx = filtered.indexOf(tmpl);
                    const adapted = adaptedTexts[tmpl.id];
                    const isOcrTemplate = tmpl.text.includes("[物件名]") && tmpl.text.includes("[住所]");
                    const _rawText = extractedTexts[tmpl.id] || adapted || tmpl.text;
                    let displayText = applyVacatingDates(_rawText, vacatingDates[tmpl.id] ?? null);
                    if (soloEntry) displayText = applySoloEntry(displayText);
                    const isHighlighted = !!highlightKeyword && (tmpl.label.includes(highlightKeyword) || tmpl.text.includes(highlightKeyword));
                    const isVacating = tmpl.label.includes("退去予定") || /[◯○〇]月[◯○〇]/.test(tmpl.text) || /退去予定|退去後|以降ご内覧可能/.test(tmpl.text);
                    return (
                      <div key={tmpl.id} className={`rounded-2xl p-4 ${isHighlighted ? "border-2 border-orange-400 bg-orange-50" : "border border-[#e9edef] bg-[#f8f9fa]"}`}>
                        {/* タイトル行 */}
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-[#1565C0] flex-1 min-w-0 break-words leading-snug">{tmpl.label}</span>
                          {isHighlighted && (
                            <span className="shrink-0 rounded-full bg-orange-400 px-2 py-0.5 text-[10px] font-bold text-white">{highlightLabel ?? "💡 次のアクション"}</span>
                          )}
                          {isSearching && !isHighlighted && (
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
                                onClick={() => setInspectingId(inspectingId === tmpl.id ? null : tmpl.id)}
                                className={`text-[11px] transition font-medium ${inspectingId === tmpl.id ? "text-[#1565C0]" : "text-[#aaa] hover:text-[#1565C0]"}`}
                              >確認</button>
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

                        {/* 退去予定日ピッカー */}
                        {isVacating && editingId !== tmpl.id && (
                          <VacatingDatePicker
                            value={vacatingDates[tmpl.id] ?? null}
                            onChange={(date) => setVacatingDates(prev => ({ ...prev, [tmpl.id]: date }))}
                          />
                        )}

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
                            {/* 構成ブロック編集 */}
                            <div className="rounded-xl border border-[#d1d7db] bg-white p-2">
                              <div className="mb-1.5 flex items-center justify-between">
                                <p className="text-[10px] font-bold text-[#54656f]">📐 構成ブロック（任意）</p>
                                <button
                                  onClick={() => setEditStructure(prev => [...prev, { label: `ブロック${prev.length + 1}`, text: "" }])}
                                  className="rounded-full bg-[#e3f0ff] px-2 py-0.5 text-[10px] font-bold text-[#1565C0]"
                                >＋ 追加</button>
                              </div>
                              {editStructure.length === 0 && (
                                <p className="text-[10px] text-[#aaa] text-center py-1">ブロックなし（例文のみ）</p>
                              )}
                              {editStructure.map((block, bi) => (
                                <div key={bi} className="mb-1.5 flex gap-1 items-start">
                                  <div className="flex flex-col gap-1 flex-1 min-w-0">
                                    <input
                                      value={block.label}
                                      onChange={(e) => setEditStructure(prev => prev.map((b, i) => i === bi ? { ...b, label: e.target.value } : b))}
                                      placeholder="ブロック名（例: ①申込状況の説明）"
                                      className="w-full rounded-lg border border-[#d1d7db] px-2 py-1 text-[10px] outline-none focus:border-[#2196F3] font-bold"
                                    />
                                    <textarea
                                      value={block.text}
                                      onChange={(e) => setEditStructure(prev => prev.map((b, i) => i === bi ? { ...b, text: e.target.value } : b))}
                                      placeholder="例文テキスト"
                                      rows={2}
                                      className="w-full rounded-lg border border-[#d1d7db] px-2 py-1 text-[10px] outline-none focus:border-[#2196F3] resize-none"
                                    />
                                  </div>
                                  <button
                                    onClick={() => setEditStructure(prev => prev.filter((_, i) => i !== bi))}
                                    className="mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-red-100 text-[10px] text-red-500"
                                  >×</button>
                                </div>
                              ))}
                            </div>
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

                        {/* 例文 / 構成 トグル（非AIXのみ） */}
                        {tmpl.structure && tmpl.structure.length > 0 && !tmpl.category.includes("AIX") && (() => {
                          const showingSample = structureViewId !== tmpl.id;
                          return (
                            <div className="mb-2 flex gap-1">
                              <button
                                onClick={() => setStructureViewId(null)}
                                className={`rounded-full px-3 py-1 text-[10px] font-bold transition ${showingSample ? "bg-[#1565C0] text-white" : "border border-[#d1d7db] bg-white text-[#54656f]"}`}
                              >例文</button>
                              <button
                                onClick={() => setStructureViewId(tmpl.id)}
                                className={`rounded-full px-3 py-1 text-[10px] font-bold transition ${!showingSample ? "bg-[#7B1FA2] text-white" : "border border-[#d1d7db] bg-white text-[#54656f]"}`}
                              >📐 構成</button>
                            </div>
                          );
                        })()}
                        {/* 構成ビュー or テキスト */}
                        {(() => {
                          const isAix = tmpl.category.includes("AIX");
                          const hasStructure = !!(tmpl.structure && tmpl.structure.length > 0);
                          // AIXは常に見本テキストを表示（構成は訴求ポイントの上で別途表示）
                          const showStructure = hasStructure && !isAix && structureViewId === tmpl.id;
                          if (showStructure) {
                            return (
                              <div className="mb-3 flex flex-col gap-2">
                                {tmpl.structure!.map((block, bi) => (
                                  <div key={bi} className="rounded-xl border border-[#e3eaf2] bg-white p-2.5">
                                    <p className="mb-1 text-[10px] font-bold text-[#7B1FA2]">{block.label}</p>
                                    <p className="whitespace-pre-wrap text-[12px] leading-5 text-[#111b21]">{block.text ? block.text : <span className="text-[#aaa]">（説明未設定）</span>}</p>
                                  </div>
                                ))}
                              </div>
                            );
                          }
                          return <p className="whitespace-pre-wrap text-[13px] leading-5 text-[#111b21] mb-3">{displayText}</p>;
                        })()}

                        {/* 確認パネル */}
                        {inspectingId === tmpl.id && (() => {
                          const elements = detectTemplateElements(tmpl.text);
                          const hasVars = /アカウント名|〇〇|○○/.test(tmpl.text);
                          const hasStation = /徒歩[0-9]|[0-9]分|駅.*徒歩|電車.*本|線.*駅/.test(tmpl.text);
                          const hasPropertyName = /🌟|⭐|【新築|【物件|マンション名|物件名/.test(tmpl.text);
                          return (
                            <div className="mb-3 rounded-xl border border-[#e3eaf2] bg-[#f8fafc] px-3 py-3 flex flex-col gap-3">
                              {/* テンプレートは構成のもの — 説明 */}
                              <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2">
                                <p className="text-[10px] font-bold text-blue-700 mb-1">📐 これは構成テンプレートです</p>
                                <p className="text-[10px] text-blue-600 leading-relaxed">「AIで最適化」を押すと、お客様の条件・会話履歴をもとに内容が自動で書き換わります。固定の物件名や駅情報はお客様に合わせて変動します。</p>
                              </div>
                              {/* 変動箇所ハイライト */}
                              {(hasVars || hasPropertyName || hasStation) && (
                                <div>
                                  <p className="mb-1.5 text-[10px] font-bold text-[#54656f]">✏️ AIが自動で変える箇所</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {/アカウント名/.test(tmpl.text) && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-700">アカウント名 → お客様名</span>}
                                    {/〇〇|○○/.test(tmpl.text) && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-700">〇〇 → 物件・条件情報</span>}
                                    {hasPropertyName && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">物件名 → 今回の物件名</span>}
                                    {hasStation && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">🚃 駅情報 → 希望なければ省略</span>}
                                  </div>
                                </div>
                              )}
                              {/* 駅情報の注意書き */}
                              {hasStation && (
                                <div className="rounded-lg bg-amber-50 border border-amber-200 px-2 py-1.5 flex items-start gap-1.5">
                                  <span className="text-[13px] flex-shrink-0">⚠️</span>
                                  <p className="text-[10px] text-amber-700 leading-relaxed">このテンプレートに駅情報が含まれています。お客様が希望エリア・駅・徒歩分数を指定していない場合、AIは自動でその部分を省略します。</p>
                                </div>
                              )}
                              {/* メッセージ要素 */}
                              {elements.length > 0 && (
                                <div>
                                  <p className="mb-1.5 text-[10px] font-bold text-[#54656f]">📋 このテンプレートの構成要素</p>
                                  <div className="flex flex-col gap-1">
                                    {elements.map((e, i) => (
                                      <div key={i} className={`flex items-center gap-1.5 rounded-lg px-2 py-1 ${e.bg}`}>
                                        <span className="text-[13px]">{e.emoji}</span>
                                        <span className={`text-[11px] font-bold ${e.fg}`}>{e.label}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                        </>
                        )}

                        {/* 画像必要テンプレ: 複数画像ピッカー */}
                        {editingId !== tmpl.id && tmpl.requires_image && (
                          <div className="mb-3">
                            {/* サムネイル一覧 */}
                            {(templateImagePreviews[tmpl.id] ?? []).length > 0 && (
                              <div className="mb-2 flex flex-wrap gap-2">
                                {(templateImagePreviews[tmpl.id] ?? []).map((preview, idx) => (
                                  <div key={idx} className="relative w-20 h-20 rounded-xl overflow-hidden border border-sky-200 flex-shrink-0">
                                    <img src={preview} className="w-full h-full object-cover" alt={`画像${idx + 1}`} />
                                    <button
                                      onClick={() => {
                                        setTemplateImages(prev => {
                                          const arr = [...(prev[tmpl.id] ?? [])];
                                          arr.splice(idx, 1);
                                          return { ...prev, [tmpl.id]: arr };
                                        });
                                        setTemplateImagePreviews(prev => {
                                          const arr = [...(prev[tmpl.id] ?? [])];
                                          arr.splice(idx, 1);
                                          return { ...prev, [tmpl.id]: arr };
                                        });
                                      }}
                                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center"
                                    >×</button>
                                  </div>
                                ))}
                                {/* 追加ボタン */}
                                {!isOcrTemplate && (
                                  <button
                                    onClick={() => templateImageInputRefs.current[tmpl.id]?.click()}
                                    className="w-20 h-20 rounded-xl border-2 border-dashed border-sky-300 bg-sky-50 text-sky-500 text-[11px] font-bold flex flex-col items-center justify-center gap-1"
                                  >
                                    <span className="text-lg">📎</span>
                                    <span>追加</span>
                                  </button>
                                )}
                              </div>
                            )}
                            {/* 初回添付ボタン */}
                            {(templateImagePreviews[tmpl.id] ?? []).length === 0 && (
                              <button
                                onClick={() => templateImageInputRefs.current[tmpl.id]?.click()}
                                className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-sky-300 py-3 text-[11px] font-bold text-sky-600 bg-sky-50"
                              >📎 {isOcrTemplate ? "物件資料を読み込む（物件名・住所を自動取得）" : "物件資料画像を添付（必須）"}</button>
                            )}
                            {extractErrors[tmpl.id] && (
                              <p className="mt-1 text-[10px] text-red-500">{extractErrors[tmpl.id]}</p>
                            )}
                            {extractingId === tmpl.id && (
                              <div className="mt-1 flex items-center gap-2 text-[11px] text-sky-600 font-bold">
                                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
                                物件名・住所を読み取り中...
                              </div>
                            )}
                            <input
                              type="file" accept="image/*" multiple className="hidden"
                              ref={el => { templateImageInputRefs.current[tmpl.id] = el; }}
                              onChange={async (e) => {
                                const files = Array.from(e.target.files ?? []);
                                if (files.length === 0) return;
                                e.target.value = "";
                                for (const f of files) {
                                  await new Promise<void>((resolve) => {
                                    const reader = new FileReader();
                                    reader.onload = async () => {
                                      const dataUrl = String(reader.result ?? "");
                                      setTemplateImages(prev => ({ ...prev, [tmpl.id]: [...(prev[tmpl.id] ?? []), f] }));
                                      setTemplateImagePreviews(prev => ({ ...prev, [tmpl.id]: [...(prev[tmpl.id] ?? []), dataUrl] }));

                                      if (isOcrTemplate) {
                                        setExtractingId(tmpl.id);
                                        setExtractErrors(prev => { const n = { ...prev }; delete n[tmpl.id]; return n; });
                                        try {
                                          const base64 = dataUrl.split(",")[1];
                                          const mime = dataUrl.split(";")[0].split(":")[1] as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
                                          const res = await fetch("/api/extract-meeting-place", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ image_base64: base64, media_type: mime }),
                                          });
                                          const data = await res.json() as { ok: boolean; name?: string; address?: string; error?: string };
                                          if (data.ok && (data.name || data.address)) {
                                            const filled = tmpl.text
                                              .replace("[物件名]", data.name || "[物件名]")
                                              .replace("[住所]", data.address || "[住所]");
                                            setExtractedTexts(prev => ({ ...prev, [tmpl.id]: filled }));
                                          } else {
                                            setExtractErrors(prev => ({ ...prev, [tmpl.id]: data.error || "読み取り失敗 — 手動で入力してください" }));
                                          }
                                        } catch {
                                          setExtractErrors(prev => ({ ...prev, [tmpl.id]: "通信エラー — 手動で入力してください" }));
                                        } finally {
                                          setExtractingId(null);
                                        }
                                      }
                                      resolve();
                                    };
                                    reader.readAsDataURL(f);
                                  });
                                }
                              }}
                            />
                          </div>
                        )}

                        {/* AIXカテゴリ: 構成ブロック常時表示（見本の下・訴求ポイントの上） */}
                        {editingId !== tmpl.id && tmpl.category.includes("AIX") && tmpl.structure && tmpl.structure.length > 0 && (
                          <div className="mb-3">
                            <p className="mb-1.5 text-[10px] font-bold text-[#7B1FA2]">構成</p>
                            <div className="rounded-xl border border-[#e3eaf2] bg-white overflow-hidden">
                              {tmpl.structure.map((block, bi) => (
                                <div key={bi} className={`px-3 py-2 ${bi > 0 ? "border-t border-[#f0f2f5]" : ""}`}>
                                  <p className="mb-0.5 text-[10px] font-bold text-[#7B1FA2]">{block.label}</p>
                                  {block.text ? (
                                    <p className="whitespace-pre-wrap text-[11px] leading-4 text-[#54656f]">{block.text}</p>
                                  ) : (
                                    <p className="text-[10px] text-[#aaa]">（説明未設定）</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* AIXカテゴリ: 訴求ポイント選択 */}
                        {editingId !== tmpl.id && tmpl.category.includes("AIX") && (
                          <div className="mb-2">
                            <p className="mb-1.5 text-[11px] font-semibold text-[#8696a0]">訴求ポイント（任意）</p>
                            <div className="flex flex-wrap gap-1.5">
                              {(["家賃", "初期費用", "部屋の条件"] as const).map((pt) => {
                                const selected = (focusPointsMap[tmpl.id] ?? []).includes(pt);
                                return (
                                  <button
                                    key={pt}
                                    type="button"
                                    onClick={() => {
                                      setFocusPointsMap(prev => {
                                        const current = prev[tmpl.id] ?? [];
                                        const next = selected ? current.filter(p => p !== pt) : [...current, pt];
                                        return { ...prev, [tmpl.id]: next };
                                      });
                                    }}
                                    className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                                      selected
                                        ? "border-orange-400 bg-orange-400 text-white"
                                        : "border-[#d1d7db] bg-white text-[#667781]"
                                    }`}
                                  >
                                    {selected ? "✓ " : ""}{pt}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* ボタン行 */}
                        {editingId !== tmpl.id && <div className="flex items-center gap-2 flex-wrap">
                          {onSelect && (
                            <button
                              onClick={() => {
                                // AIXカテゴリはAIXモーダルを開く（訴求ポイント引き継ぎ）
                                if (tmpl.category.includes("AIX") && onOpenAixWithFocus) {
                                  onOpenAixWithFocus(focusPointsMap[tmpl.id] ?? [], { name: tmpl.label, category: tmpl.category, structure: tmpl.structure ?? undefined, sample: tmpl.text || undefined });
                                  onClose();
                                  return;
                                }
                                if (tmpl.requires_image && (templateImages[tmpl.id] ?? []).length === 0) {
                                  alert("📎 物件資料を画像で読み込んでください");
                                  return;
                                }
                                if (isOcrTemplate && extractingId === tmpl.id) return;
                                // OCRテンプレートは画像をLINEに添付しない（物件名・住所抽出のみ）
                                onSelect(displayText, isOcrTemplate ? undefined : (templateImages[tmpl.id] ?? []), tmpl.label, tmpl.category);
                                onClose();
                              }}
                              disabled={isOcrTemplate && extractingId === tmpl.id}
                              className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                              style={{ background: "linear-gradient(135deg, #06c755, #06a043)" }}
                            >
                              {tmpl.category.includes("AIX") ? "AIXで生成" : "そのまま使う"}
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
                              onClick={() => { onSelect(adapted, templateImages[tmpl.id] ?? []); onClose(); }}
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
