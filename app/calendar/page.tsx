"use client";

import { useEffect, useState } from "react";
import BottomNav from "../components/BottomNav";
import { supabase } from "../lib/supabase";

type EventType = "viewing" | "contract" | "key_handover" | "other";

type CalendarEvent = {
  id: string;
  title: string;
  event_type: EventType;
  customer_name: string;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  notes: string;
};

const EVENT_TYPE_CONFIG: Record<EventType, { label: string; color: string; bg: string; emoji: string }> = {
  viewing:      { label: "内覧",   color: "#2196F3", bg: "#e3f2fd", emoji: "🔍" },
  contract:     { label: "契約",   color: "#4CAF50", bg: "#e8f5e9", emoji: "📝" },
  key_handover: { label: "鍵渡し", color: "#FF9800", bg: "#fff3e0", emoji: "🔑" },
  other:        { label: "その他", color: "#9E9E9E", bg: "#f5f5f5", emoji: "📌" },
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function formatDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTimeJP(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function toLocalInputValue(date: Date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

export default function CalendarPage() {
  const today = new Date();

  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date>(today);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);

  // フォーム
  const [form, setForm] = useState({
    title: "",
    event_type: "viewing" as EventType,
    customer_name: "",
    start_at: toLocalInputValue(today),
    end_at: "",
    all_day: false,
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateCategory, setTemplateCategory] = useState("初回応対");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    fetchEvents();
  }, [year, month]);

  const fetchEvents = async () => {
    setLoading(true);
    const startOfMonth = new Date(year, month, 1).toISOString();
    const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59).toISOString();

    const { data, error } = await supabase
      .from("calendar_events")
      .select("*")
      .gte("start_at", startOfMonth)
      .lte("start_at", endOfMonth)
      .order("start_at", { ascending: true });

    if (!error && data) {
      setEvents(data as CalendarEvent[]);
    }
    setLoading(false);
  };

  // カレンダーグリッド生成
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (Date | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const eventsByDate: Record<string, CalendarEvent[]> = {};
  for (const ev of events) {
    const key = ev.start_at.slice(0, 10);
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(ev);
  }

  const selectedKey = formatDateKey(selectedDate);
  const selectedEvents = eventsByDate[selectedKey] || [];

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  };

  const openCreate = () => {
    const base = new Date(selectedDate);
    base.setHours(10, 0, 0, 0);
    setForm({
      title: "",
      event_type: "viewing",
      customer_name: "",
      start_at: toLocalInputValue(base),
      end_at: "",
      all_day: false,
      notes: "",
    });
    setEditingEvent(null);
    setFormError("");
    setShowModal(true);
  };

  const openEdit = (ev: CalendarEvent) => {
    setForm({
      title: ev.title,
      event_type: ev.event_type,
      customer_name: ev.customer_name || "",
      start_at: ev.start_at.slice(0, 16),
      end_at: ev.end_at ? ev.end_at.slice(0, 16) : "",
      all_day: ev.all_day,
      notes: ev.notes || "",
    });
    setEditingEvent(ev);
    setFormError("");
    setShowModal(true);
  };

  const saveEvent = async () => {
    if (!form.title.trim()) { setFormError("タイトルを入力してください"); return; }
    if (!form.start_at) { setFormError("日時を入力してください"); return; }

    setSaving(true);
    setFormError("");

    const payload = {
      title: form.title.trim(),
      event_type: form.event_type,
      customer_name: form.customer_name.trim(),
      start_at: new Date(form.start_at).toISOString(),
      end_at: form.end_at ? new Date(form.end_at).toISOString() : null,
      all_day: form.all_day,
      notes: form.notes.trim(),
    };

    let error;
    if (editingEvent) {
      ({ error } = await supabase.from("calendar_events").update(payload).eq("id", editingEvent.id));
    } else {
      ({ error } = await supabase.from("calendar_events").insert(payload));
    }

    setSaving(false);
    if (error) { setFormError("保存に失敗しました"); return; }

    setShowModal(false);
    fetchEvents();
  };

  const deleteEvent = async (id: string) => {
    if (!confirm("この予定を削除しますか？")) return;
    await supabase.from("calendar_events").delete().eq("id", id);
    fetchEvents();
  };

  const isToday = (d: Date) =>
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();

  const isSelected = (d: Date) => formatDateKey(d) === selectedKey;

  return (
    <main
      className="flex h-[calc(100svh-56px)] flex-col overflow-hidden"
      style={{ background: "linear-gradient(180deg, #deeeff 0%, #eef6ff 60%, #f5faff 100%)" }}
    >
      {/* ヘッダー */}
      <header
        className="px-4 pb-3 pt-[max(10px,env(safe-area-inset-top))]"
        style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
      >
        <div className="flex items-center justify-between">
          <button onClick={prevMonth} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-white text-lg">
            ‹
          </button>
          <div className="text-center">
            <div className="text-lg font-bold text-white">{year}年{month + 1}月</div>
          </div>
          <button onClick={nextMonth} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-white text-lg">
            ›
          </button>
        </div>

        {/* 曜日ヘッダー */}
        <div className="mt-2 grid grid-cols-7 text-center">
          {WEEKDAYS.map((w, i) => (
            <div key={w} className={`text-xs font-semibold ${i === 0 ? "text-red-300" : i === 6 ? "text-blue-200" : "text-white/80"}`}>
              {w}
            </div>
          ))}
        </div>
      </header>

      {/* カレンダーグリッド */}
      <div className="bg-white px-1 pt-1">
        <div className="grid grid-cols-7">
          {cells.map((date, idx) => {
            if (!date) return <div key={`empty-${idx}`} className="h-14 border-b border-r border-gray-100" />;
            const key = formatDateKey(date);
            const dayEvents = eventsByDate[key] || [];
            const dow = date.getDay();

            return (
              <button
                key={key}
                onClick={() => setSelectedDate(date)}
                className="relative flex h-14 flex-col items-center border-b border-r border-gray-100 pt-1"
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold
                    ${isSelected(date) ? "text-white" : isToday(date) ? "font-bold" : ""}
                    ${dow === 0 ? "text-red-500" : dow === 6 ? "text-blue-500" : "text-[#111b21]"}
                  `}
                  style={
                    isSelected(date)
                      ? { background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }
                      : isToday(date)
                      ? { border: "2px solid #2196F3", color: "#2196F3" }
                      : {}
                  }
                >
                  {date.getDate()}
                </span>

                {/* イベントドット */}
                <div className="mt-0.5 flex gap-0.5">
                  {dayEvents.slice(0, 3).map((ev) => (
                    <span
                      key={ev.id}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: EVENT_TYPE_CONFIG[ev.event_type]?.color ?? "#9E9E9E" }}
                    />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 選択日のイベント一覧 */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-bold text-[#1565C0]">
            {selectedDate.getMonth() + 1}月{selectedDate.getDate()}日（{WEEKDAYS[selectedDate.getDay()]}）
          </div>
          {loading && <div className="text-xs text-[#8696a0]">読込中...</div>}
        </div>

        {selectedEvents.length === 0 ? (
          <div className="mb-4 rounded-2xl bg-white px-4 py-5 text-center text-sm text-[#8696a0] shadow-sm">
            予定はありません
          </div>
        ) : (
          <div className="mb-4 flex flex-col gap-2">
            {selectedEvents.map((ev) => {
              const cfg = EVENT_TYPE_CONFIG[ev.event_type] ?? EVENT_TYPE_CONFIG.other;
              return (
                <button
                  key={ev.id}
                  onClick={() => openEdit(ev)}
                  className="flex items-start gap-3 rounded-2xl bg-white px-4 py-3 text-left shadow-sm"
                >
                  <span
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base"
                    style={{ backgroundColor: cfg.bg }}
                  >
                    {cfg.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                        style={{ backgroundColor: cfg.color }}
                      >
                        {cfg.label}
                      </span>
                      <span className="truncate text-[15px] font-semibold text-[#111b21]">{ev.title}</span>
                    </div>
                    {ev.customer_name && (
                      <div className="mt-0.5 text-xs text-[#667781]">👤 {ev.customer_name}</div>
                    )}
                    <div className="mt-0.5 text-xs text-[#667781]">
                      {ev.all_day ? "終日" : `${formatTimeJP(ev.start_at)}${ev.end_at ? ` 〜 ${formatTimeJP(ev.end_at)}` : ""}`}
                    </div>
                    {ev.notes && <div className="mt-0.5 truncate text-xs text-[#8696a0]">{ev.notes}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* 新しい予定の作成ボタン */}
        <button
          onClick={openCreate}
          className="flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-[15px] font-bold text-white shadow-md"
          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
        >
          ＋ 新しい予定の作成
        </button>
      </div>

      {/* テンプレートボタン（BottomNavの上） */}
      <div className="relative z-30 flex justify-center border-t border-[#e9edef] bg-white/90 py-2 backdrop-blur-sm">
        <button
          onClick={() => setShowTemplates(true)}
          className="flex items-center gap-2 rounded-full px-6 py-2 text-sm font-bold text-white shadow-md"
          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
        >
          📋 テンプレート
        </button>
      </div>

      <BottomNav />

      {/* テンプレートモーダル */}
      {showTemplates && (
        <TemplateModal
          onClose={() => setShowTemplates(false)}
          category={templateCategory}
          setCategory={setTemplateCategory}
          copiedId={copiedId}
          setCopiedId={setCopiedId}
        />
      )}

      {/* 予定作成・編集モーダル */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <div className="w-full max-w-lg rounded-t-3xl bg-white shadow-2xl">
            {/* モーダルヘッダー */}
            <div
              className="flex items-center justify-between rounded-t-3xl px-5 py-4"
              style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
            >
              <div className="text-[17px] font-bold text-white">
                {editingEvent ? "予定を編集" : "📅 新しい予定の作成"}
              </div>
              <div className="flex items-center gap-2">
                {editingEvent && (
                  <button
                    onClick={() => deleteEvent(editingEvent.id)}
                    className="rounded-full bg-red-400/80 px-3 py-1 text-xs font-semibold text-white"
                  >
                    削除
                  </button>
                )}
                <button
                  onClick={() => setShowModal(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-5">
              {/* 種別 */}
              <div className="mb-4">
                <div className="mb-2 text-xs font-semibold text-[#54656f]">種別</div>
                <div className="grid grid-cols-4 gap-2">
                  {(Object.entries(EVENT_TYPE_CONFIG) as [EventType, typeof EVENT_TYPE_CONFIG.other][]).map(([key, cfg]) => (
                    <button
                      key={key}
                      onClick={() => setForm(f => ({ ...f, event_type: key }))}
                      className="flex flex-col items-center rounded-xl py-2 text-xs font-semibold transition"
                      style={
                        form.event_type === key
                          ? { backgroundColor: cfg.color, color: "white" }
                          : { backgroundColor: cfg.bg, color: cfg.color }
                      }
                    >
                      <span className="mb-0.5 text-lg">{cfg.emoji}</span>
                      {cfg.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* タイトル */}
              <div className="mb-4">
                <label className="mb-1 block text-xs font-semibold text-[#54656f]">タイトル *</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="例：田中様 内覧対応"
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                />
              </div>

              {/* 顧客名 */}
              <div className="mb-4">
                <label className="mb-1 block text-xs font-semibold text-[#54656f]">顧客名</label>
                <input
                  type="text"
                  value={form.customer_name}
                  onChange={(e) => setForm(f => ({ ...f, customer_name: e.target.value }))}
                  placeholder="例：田中 太郎"
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                />
              </div>

              {/* 終日トグル */}
              <div className="mb-4 flex items-center justify-between rounded-xl border border-[#d1d7db] px-4 py-3">
                <span className="text-sm font-semibold text-[#111b21]">終日</span>
                <button
                  onClick={() => setForm(f => ({ ...f, all_day: !f.all_day }))}
                  className="relative h-6 w-11 rounded-full transition-colors"
                  style={{ backgroundColor: form.all_day ? "#2196F3" : "#d1d7db" }}
                >
                  <span
                    className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform"
                    style={{ transform: form.all_day ? "translateX(20px)" : "translateX(2px)" }}
                  />
                </button>
              </div>

              {/* 開始日時 */}
              {!form.all_day && (
                <>
                  <div className="mb-4">
                    <label className="mb-1 block text-xs font-semibold text-[#54656f]">開始日時 *</label>
                    <input
                      type="datetime-local"
                      value={form.start_at}
                      onChange={(e) => setForm(f => ({ ...f, start_at: e.target.value }))}
                      className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3]"
                    />
                  </div>
                  <div className="mb-4">
                    <label className="mb-1 block text-xs font-semibold text-[#54656f]">終了日時（任意）</label>
                    <input
                      type="datetime-local"
                      value={form.end_at}
                      onChange={(e) => setForm(f => ({ ...f, end_at: e.target.value }))}
                      className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3]"
                    />
                  </div>
                </>
              )}

              {form.all_day && (
                <div className="mb-4">
                  <label className="mb-1 block text-xs font-semibold text-[#54656f]">日付 *</label>
                  <input
                    type="date"
                    value={form.start_at.slice(0, 10)}
                    onChange={(e) => setForm(f => ({ ...f, start_at: e.target.value + "T00:00" }))}
                    className="w-full rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3]"
                  />
                </div>
              )}

              {/* メモ */}
              <div className="mb-4">
                <label className="mb-1 block text-xs font-semibold text-[#54656f]">メモ（任意）</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="例：〇〇マンション202号室、駐車場あり..."
                  rows={2}
                  className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2.5 text-sm text-[#111b21] outline-none focus:border-[#2196F3] placeholder:text-[#8696a0]"
                />
              </div>

              {formError && (
                <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{formError}</div>
              )}

              <button
                onClick={saveEvent}
                disabled={saving}
                className="w-full rounded-full py-3.5 text-sm font-bold text-white disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
              >
                {saving ? "保存中..." : editingEvent ? "変更を保存" : "予定を追加する"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ────────────────────────────────────────────────────────────────
//  テンプレートデータ
// ────────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, { id: string; label: string; text: string }[]> = {
  "初回応対": [
    {
      id: "t1",
      label: "初回あいさつ",
      text: "はじめまして！スモラの担当です😊\nどのようなお部屋をお探しでしょうか？\nご希望の条件をお聞かせいただければ、条件に合ったお部屋をピックアップしてご提案させて頂きます！",
    },
    {
      id: "t2",
      label: "連絡お礼",
      text: "ご連絡いただきありがとうございます！\nスモラでご希望のお部屋を一緒に探しましょう😊\nまずは、ご希望の家賃・エリア・間取りをお聞かせください！",
    },
  ],
  "物件探し中": [
    {
      id: "t3",
      label: "条件ヒアリング",
      text: "ご希望の条件をもう少し詳しくお聞かせください😊\n・ご希望の家賃帯\n・エリア（駅名など）\n・間取り（1K・1LDKなど）\n・ご入居希望時期",
    },
    {
      id: "t4",
      label: "物件提案",
      text: "〇〇さんの条件に近いお部屋をいくつかピックアップしました😊\nご確認いただき、気になるお部屋があればぜひ教えてください！",
    },
    {
      id: "t5",
      label: "空き確認中",
      text: "ご希望のお部屋の空き状況を確認いたします！\n少々お時間をいただきますが、わかり次第ご連絡いたします😊",
    },
  ],
  "内覧": [
    {
      id: "t6",
      label: "内覧お誘い",
      text: "お気に召したお部屋はございましたか？😊\nぜひ一度内覧されてみませんか？\nご都合の良い日時をいくつかお知らせいただければご予約いたします！",
    },
    {
      id: "t7",
      label: "内覧確認",
      text: "内覧のご予約ありがとうございます！\n当日は〇〇（住所）にお集まりください😊\nご不明な点がございましたらお気軽にご連絡ください！",
    },
  ],
  "申込・審査": [
    {
      id: "t8",
      label: "申込後押し",
      text: "〇〇さんの条件にかなり近いお部屋となっておりますので、\nお気に召されましたらお申込してお部屋をおさえさせて頂きます！！\n今の市場では人気物件はすぐに埋まってしまいますので、ぜひご検討ください😊",
    },
    {
      id: "t9",
      label: "書類案内",
      text: "お申込ありがとうございます！\n審査に必要な書類をご準備いただけますか？\n・身分証明書（運転免許証など）\n・収入証明書（源泉徴収票など）\nご不明な点はお気軽にどうぞ😊",
    },
    {
      id: "t10",
      label: "審査結果待ち",
      text: "現在審査を進めております😊\n結果が出ましたらすぐにご連絡いたします！\nもうしばらくお待ちください。",
    },
  ],
  "契約・成約": [
    {
      id: "t11",
      label: "審査通過",
      text: "おめでとうございます🎉 審査が通過いたしました！\n次は契約手続きに進みます。\n契約書の内容についてご説明しますので、日程を調整させてください😊",
    },
    {
      id: "t12",
      label: "ご成約お礼",
      text: "この度はご成約おめでとうございます🎉\nご入居まで引き続きサポートいたします！\n新生活のスタートが素晴らしいものになりますよう応援しております😊",
    },
    {
      id: "t13",
      label: "鍵渡し案内",
      text: "鍵のお渡しについてのご案内です🔑\n〇月〇日〇時に〇〇（場所）にてお渡しいたします。\nご確認よろしくお願いいたします😊",
    },
  ],
};

const TEMPLATE_CATEGORIES = Object.keys(TEMPLATES);

function TemplateModal({
  onClose,
  category,
  setCategory,
  copiedId,
  setCopiedId,
}: {
  onClose: () => void;
  category: string;
  setCategory: (c: string) => void;
  copiedId: string | null;
  setCopiedId: (id: string | null) => void;
}) {
  const templates = TEMPLATES[category] || [];

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-t-3xl bg-white shadow-2xl">
        {/* ヘッダー */}
        <div
          className="flex items-center justify-between rounded-t-3xl px-5 py-4"
          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
        >
          <div className="text-[17px] font-bold text-white">📋 テンプレート</div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white"
          >
            ✕
          </button>
        </div>

        {/* カテゴリタブ */}
        <div className="flex gap-1.5 overflow-x-auto border-b border-[#f0f2f5] bg-white px-4 py-2.5">
          {TEMPLATE_CATEGORIES.map((cat) => (
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

        {/* テンプレート一覧 */}
        <div className="max-h-[55vh] overflow-y-auto p-4">
          <div className="flex flex-col gap-3">
            {templates.map((tmpl) => (
              <div key={tmpl.id} className="rounded-2xl border border-[#e9edef] bg-[#f8f9fa] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold text-[#1565C0]">{tmpl.label}</span>
                  <button
                    onClick={() => copyText(tmpl.id, tmpl.text)}
                    className="rounded-full px-3 py-1 text-xs font-bold text-white transition"
                    style={
                      copiedId === tmpl.id
                        ? { backgroundColor: "#4CAF50" }
                        : { background: "linear-gradient(135deg, #1565C0, #4BA8E8)" }
                    }
                  >
                    {copiedId === tmpl.id ? "✓ コピー済み" : "コピー"}
                  </button>
                </div>
                <p className="whitespace-pre-wrap text-[13px] leading-5 text-[#111b21]">
                  {tmpl.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
