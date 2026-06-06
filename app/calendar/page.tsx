"use client";

import { useEffect, useRef, useState } from "react";
import BottomNav from "../components/BottomNav";
import { registerSW, requestNotifPermission, showNotif } from "../lib/notifications";
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
  _source: "local";
};

type DailyTask = {
  id: string;
  customer_name: string;
  content: string;
  date: string;
  time: string;
  end_time: string;
  done: boolean;
  management_company: string;
  _source: "screening_admin";
};

type AnyEvent = CalendarEvent | DailyTask;

const EVENT_TYPE_CONFIG: Record<EventType, { label: string; color: string; bg: string; emoji: string }> = {
  viewing:      { label: "内覧",   color: "#2196F3", bg: "#e3f2fd", emoji: "🔍" },
  contract:     { label: "契約",   color: "#4CAF50", bg: "#e8f5e9", emoji: "📝" },
  key_handover: { label: "鍵渡し", color: "#FF9800", bg: "#fff3e0", emoji: "🔑" },
  other:        { label: "その他", color: "#9E9E9E", bg: "#f5f5f5", emoji: "📌" },
};

const SCREENING_COLOR = "#8B5CF6";
const SCREENING_BG = "#F3E8FF";

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
  const [dailyTasks, setDailyTasks] = useState<DailyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);

  const [form, setForm] = useState({
    title: "",
    event_type: "viewing" as EventType,
    customer_name: "",
    start_at: toLocalInputValue(today),
    end_at: "",
    all_day: false,
    notes: "",
    sync_to_screening: false,
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const notifiedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    registerSW().then(() => requestNotifPermission());

    const calendarAlarm = setInterval(async () => {
      const now = new Date();
      const from = now.toISOString();
      const to = new Date(now.getTime() + 16 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("calendar_events")
        .select("id, title, customer_name, start_at, event_type")
        .gte("start_at", from)
        .lte("start_at", to)
        .eq("all_day", false);
      if (!data) return;
      for (const ev of data) {
        const start = new Date(ev.start_at).getTime();
        const diff = start - now.getTime();
        const emoji = ev.event_type === "viewing" ? "🔍" : ev.event_type === "contract" ? "📝" : ev.event_type === "key_handover" ? "🔑" : "📌";
        if (diff >= 14 * 60 * 1000 && diff < 16 * 60 * 1000 && !notifiedIds.current.has(`15_${ev.id}`)) {
          notifiedIds.current.add(`15_${ev.id}`);
          showNotif(`${emoji} まもなく開始 — ${ev.title}`, `${ev.customer_name} の予定が15分後に始まります`, "/calendar");
        }
        if (diff >= 0 && diff < 2 * 60 * 1000 && !notifiedIds.current.has(`0_${ev.id}`)) {
          notifiedIds.current.add(`0_${ev.id}`);
          showNotif(`${emoji} 開始時刻です — ${ev.title}`, `${ev.customer_name} の予定が始まります`, "/calendar");
        }
      }
    }, 60 * 1000);

    return () => clearInterval(calendarAlarm);
  }, []);

  useEffect(() => {
    fetchAll();
  }, [year, month]);

  const fetchAll = async () => {
    setLoading(true);
    const startOfMonth = new Date(year, month, 1).toISOString();
    const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59).toISOString();
    const fromDate = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const toDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(new Date(year, month + 1, 0).getDate()).padStart(2, "0")}`;

    const [localResult, screeningResult] = await Promise.all([
      supabase
        .from("calendar_events")
        .select("*")
        .gte("start_at", startOfMonth)
        .lte("start_at", endOfMonth)
        .order("start_at", { ascending: true }),
      fetch(`/api/daily-tasks?from=${fromDate}&to=${toDate}`).then(r => r.ok ? r.json() : []),
    ]);

    if (!localResult.error && localResult.data) {
      setEvents((localResult.data as Omit<CalendarEvent, "_source">[]).map(e => ({ ...e, _source: "local" as const })));
    }
    if (Array.isArray(screeningResult)) {
      setDailyTasks(screeningResult.map((t: Omit<DailyTask, "_source">) => ({ ...t, _source: "screening_admin" as const })));
    }
    setLoading(false);
  };

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const eventsByDate: Record<string, AnyEvent[]> = {};
  for (const ev of events) {
    const key = ev.start_at.slice(0, 10);
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(ev);
  }
  for (const task of dailyTasks) {
    const key = task.date;
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(task);
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
      sync_to_screening: false,
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
      sync_to_screening: false,
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

    const startDate = new Date(form.start_at);
    const dateStr = form.start_at.slice(0, 10);
    const timeStr = form.all_day ? "" : `${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")}`;

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

    if (error) { setSaving(false); setFormError("保存に失敗しました"); return; }

    // 申込ツールにも同期
    if (form.sync_to_screening && !editingEvent) {
      const cfg = EVENT_TYPE_CONFIG[form.event_type];
      const endTimeStr = form.end_at
        ? `${String(new Date(form.end_at).getHours()).padStart(2, "0")}:${String(new Date(form.end_at).getMinutes()).padStart(2, "0")}`
        : "";
      await fetch("/api/daily-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_name: form.customer_name.trim(),
          content: `${cfg.emoji} ${form.title.trim()}${form.customer_name.trim() ? ` — ${form.customer_name.trim()}` : ""}`,
          date: dateStr,
          time: timeStr,
          end_time: endTimeStr,
        }),
      });
    }

    setSaving(false);
    setShowModal(false);
    fetchAll();
  };

  const deleteEvent = async (id: string) => {
    if (!confirm("この予定を削除しますか？")) return;
    await supabase.from("calendar_events").delete().eq("id", id);
    fetchAll();
  };

  const toggleTaskDone = async (task: DailyTask) => {
    await fetch(`/api/daily-tasks?id=${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: !task.done }),
    });
    setDailyTasks(prev => prev.map(t => t.id === task.id ? { ...t, done: !t.done } : t));
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
            const localCount = dayEvents.filter(e => e._source === "local").length;
            const screeningCount = dayEvents.filter(e => e._source === "screening_admin").length;
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

                <div className="mt-0.5 flex gap-0.5">
                  {/* ローカルイベントのドット */}
                  {Array.from({ length: Math.min(localCount, 2) }).map((_, i) => (
                    <span key={`l${i}`} className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                  ))}
                  {/* 申込ツールのドット */}
                  {screeningCount > 0 && (
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SCREENING_COLOR }} />
                  )}
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
              if (ev._source === "screening_admin") {
                const task = ev as DailyTask;
                return (
                  <div
                    key={task.id}
                    className="flex items-start gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm"
                  >
                    <button
                      onClick={() => toggleTaskDone(task)}
                      className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base"
                      style={{ backgroundColor: SCREENING_BG }}
                    >
                      {task.done ? "✅" : "📋"}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                          style={{ backgroundColor: SCREENING_COLOR }}
                        >
                          申込ツール
                        </span>
                        <span className={`truncate text-[14px] font-semibold ${task.done ? "line-through text-gray-400" : "text-[#111b21]"}`}>
                          {task.content}
                        </span>
                      </div>
                      {task.customer_name && (
                        <div className="mt-0.5 text-xs text-[#667781]">👤 {task.customer_name}</div>
                      )}
                      {task.time && (
                        <div className="mt-0.5 text-xs text-[#667781]">
                          🕐 {task.time}{task.end_time ? ` 〜 ${task.end_time}` : ""}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              const localEv = ev as CalendarEvent;
              const cfg = EVENT_TYPE_CONFIG[localEv.event_type] ?? EVENT_TYPE_CONFIG.other;
              return (
                <button
                  key={localEv.id}
                  onClick={() => openEdit(localEv)}
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
                      <span className="truncate text-[15px] font-semibold text-[#111b21]">{localEv.title}</span>
                    </div>
                    {localEv.customer_name && (
                      <div className="mt-0.5 text-xs text-[#667781]">👤 {localEv.customer_name}</div>
                    )}
                    <div className="mt-0.5 text-xs text-[#667781]">
                      {localEv.all_day ? "終日" : `${formatTimeJP(localEv.start_at)}${localEv.end_at ? ` 〜 ${formatTimeJP(localEv.end_at)}` : ""}`}
                    </div>
                    {localEv.notes && <div className="mt-0.5 truncate text-xs text-[#8696a0]">{localEv.notes}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <button
          onClick={openCreate}
          className="flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-[15px] font-bold text-white shadow-md"
          style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
        >
          ＋ 新しい予定の作成
        </button>
      </div>

      <BottomNav />

      {/* 予定作成・編集モーダル */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <div className="w-full max-w-lg rounded-t-3xl bg-white shadow-2xl">
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

              {/* 申込ツールへの同期トグル（新規作成時のみ） */}
              {!editingEvent && (
                <div
                  className="mb-4 flex items-center justify-between rounded-xl border-2 px-4 py-3 transition"
                  style={{
                    borderColor: form.sync_to_screening ? SCREENING_COLOR : "#d1d7db",
                    backgroundColor: form.sync_to_screening ? SCREENING_BG : "white",
                  }}
                >
                  <div>
                    <div className="text-sm font-bold" style={{ color: form.sync_to_screening ? SCREENING_COLOR : "#111b21" }}>
                      📋 申込ツールにも追加
                    </div>
                    <div className="text-xs text-[#8696a0]">管理ツールのカレンダーにも同期</div>
                  </div>
                  <button
                    onClick={() => setForm(f => ({ ...f, sync_to_screening: !f.sync_to_screening }))}
                    className="relative h-6 w-11 rounded-full transition-colors"
                    style={{ backgroundColor: form.sync_to_screening ? SCREENING_COLOR : "#d1d7db" }}
                  >
                    <span
                      className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform"
                      style={{ transform: form.sync_to_screening ? "translateX(20px)" : "translateX(2px)" }}
                    />
                  </button>
                </div>
              )}

              {formError && (
                <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{formError}</div>
              )}

              <button
                onClick={saveEvent}
                disabled={saving}
                className="w-full rounded-full py-3.5 text-sm font-bold text-white disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)" }}
              >
                {saving ? "保存中..." : editingEvent ? "変更を保存" : form.sync_to_screening ? "予定を追加する（両方に登録）" : "予定を追加する"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
