"use client";
// app/components/UndatedPromiseBar.tsx — 日付の無い連絡の約束（「来年再相談」「時期が来ましたらご案内」）の連絡の日を選んでカレンダーに入れる帯
//   2026-10-08 竹内さん「約束してカレンダーに入れる」＝日付の無い約束もカレンダーへ。日付は推測で作らず、スタッフが選ぶ。
//   値は GET/POST /api/contact-promise/undated（LLM なし）。入れた行はカレンダーと約束のバナー（【必ず】）に出る。失敗しても画面は落とさない。
//   閉じる（今回は入れない）は端末に控える（同じ約束の文では出さない）。戻す: NEXT_PUBLIC_CONTACT_PROMISE_UNDATED=off
import { useEffect, useRef, useState } from "react";

type Pending = { sentence: string; sentAt: string };
type Props = { conversationId: string; refreshKey: string; authHeader: Record<string, string> };

const DISMISS_KEY = "undatedPromiseDismissed";
function readDismissed(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
}
function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export default function UndatedPromiseBar({ conversationId, refreshKey, authHeader }: Props) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const authRef = useRef(authHeader);
  authRef.current = authHeader;

  useEffect(() => {
    setPending(null); setDone(null); setDate("");
    if (!conversationId || process.env.NEXT_PUBLIC_CONTACT_PROMISE_UNDATED === "off") return;
    const ac = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/contact-promise/undated?conversation_id=${encodeURIComponent(conversationId)}`, { headers: authRef.current, signal: ac.signal, cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { ok?: boolean; pending?: Pending | null };
        if (ac.signal.aborted || !j.ok || !j.pending) return;
        if (readDismissed()[conversationId] === j.pending.sentAt) return;
        setPending(j.pending);
      } catch { /* 出さないだけ */ }
    })();
    return () => ac.abort();
  }, [conversationId, refreshKey]);

  if (!pending && !done) return null;
  if (done) return <div className="border-b border-[#ef9a9a] bg-[#fff5f5] px-4 py-1.5 text-[11px] font-bold text-[#2e7d32]">{done}</div>;

  const save = async () => {
    if (!pending || !date || saving) return;
    setSaving(true);
    try {
      const r = await fetch("/api/contact-promise/undated", {
        method: "POST", headers: { ...authRef.current, "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, date }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setPending(null);
      setDone(`カレンダーに入れました（${date.slice(5).replace("-", "/")} に【必ず】連絡）`);
      setTimeout(() => setDone(null), 6000);
    } catch {
      setDone("入れられませんでした。もう一度お試しください");
      setTimeout(() => setDone(null), 4000);
    } finally {
      setSaving(false);
    }
  };
  const dismiss = () => {
    if (!pending) return;
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify({ ...readDismissed(), [conversationId]: pending.sentAt })); } catch { /* 端末に残せないだけ */ }
    setPending(null);
  };

  return (
    <div className="border-b border-[#ef9a9a] px-4 py-2" style={{ background: "linear-gradient(90deg, #ffebee, #fff5f5)" }}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 rounded-full bg-[#d32f2f] px-1.5 py-0.5 text-[9px] font-bold text-white">日付なし</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-bold text-[#b71c1c]">連絡の日を入れてください（約束をカレンダーの【必ず】に入れます）</span>
          <span className="block truncate text-[11px] text-[#c62828]">{pending!.sentence}</span>
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-[52px]">
        <input type="date" value={date} min={todayJst()} onChange={(e) => setDate(e.target.value)}
          className="rounded border border-[#ef9a9a] bg-white px-1.5 py-0.5 text-[12px]" />
        <button type="button" disabled={!date || saving} onClick={() => { void save(); }}
          className="rounded-full bg-[#d32f2f] px-2.5 py-0.5 text-[11px] font-bold text-white disabled:opacity-40">カレンダーに入れる</button>
        <button type="button" onClick={dismiss} className="text-[11px] text-[#8e24aa] underline">閉じる</button>
      </div>
    </div>
  );
}
