"use client";
// app/components/StaffDeviceWriterBar.tsx — この端末（ブラウザ）は 管理者（竹内さん）／スタッフ（従業員） のどちらかを選ぶ小さな帯
//   2026-10-08 竹内さんの決定11「管理者とスタッフにする」: 新しい端末でアプリを開いた時、まだ印が無ければ出す。選ぶと staff_devices.writer に入り、
//   その端末の過去の送信も埋め直す（GET/POST /api/staff-device・LLM なし）。「後で」は12時間出さない。失敗しても画面は落とさない。
//   戻す: NEXT_PUBLIC_STAFF_DEVICE_PROMPT=off
// ⚠ サーバー専用ライブラリを import しない（staff-device.ts は画面からも使える純関数＋ブラウザの関数）
import { useEffect, useState } from "react";
import { getStaffDeviceId, shouldAskDeviceWriter, DEVICE_WRITERS, DEVICE_WRITER_JA, type DeviceWriter } from "../lib/staff-device";

const DISMISS_KEY = "sumora_staff_device_prompt_dismissed_at";

export default function StaffDeviceWriterBar({ authHeader }: { authHeader: Record<string, string> }) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if ((process.env.NEXT_PUBLIC_STAFF_DEVICE_PROMPT ?? "").toLowerCase() === "off") return;
    const id = getStaffDeviceId();
    setDeviceId(id);
    if (!id) return;
    let dismissedAt: string | null = null;
    try { dismissedAt = localStorage.getItem(DISMISS_KEY); } catch { /* 読めない端末は毎回聞く */ }
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await fetch(`/api/staff-device?device_id=${encodeURIComponent(id)}`, { headers: authHeader, cache: "no-store", signal: ac.signal });
        const d = await r.json() as { ok: boolean; writer: DeviceWriter | null };
        if (!d.ok) return;
        setShow(shouldAskDeviceWriter({ deviceId: id, writer: d.writer, dismissedAt, envFlag: process.env.NEXT_PUBLIC_STAFF_DEVICE_PROMPT }));
      } catch { /* 出さない */ }
    })();
    return () => ac.abort();
    // 端末は開いた時に1回だけ見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!show || !deviceId) return null;
  const choose = async (w: DeviceWriter) => {
    if (saving) return;
    if (!window.confirm(`この端末を「${DEVICE_WRITER_JA[w]}」にします。よろしいですか？（後から変える時は管理者に連絡）`)) return;
    setSaving(true); setMsg("");
    try {
      const r = await fetch("/api/staff-device", { method: "POST", headers: { ...authHeader, "Content-Type": "application/json" }, body: JSON.stringify({ device_id: deviceId, writer: w }) });
      const d = await r.json() as { ok: boolean; error?: string; writer_ja?: string };
      if (!d.ok) { setMsg(d.error ?? "保存できませんでした"); return; }
      setMsg(`この端末は「${d.writer_ja ?? DEVICE_WRITER_JA[w]}」です`);
      setTimeout(() => setShow(false), 2500);
    } catch {
      setMsg("保存できませんでした（通信）");
    } finally {
      setSaving(false);
    }
  };
  const later = () => {
    try { localStorage.setItem(DISMISS_KEY, new Date().toISOString()); } catch { /* 無視 */ }
    setShow(false);
  };
  return (
    <div className="fixed bottom-3 left-3 z-[60] max-w-[calc(100vw-24px)] rounded-xl border border-[#d1d7db] bg-white px-3 py-2 text-[12px] text-[#3b4a54] shadow-md">
      {msg ? (
        <span>{msg}</span>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-bold">この端末は</span>
          {DEVICE_WRITERS.map((w) => (
            <button key={w} type="button" disabled={saving} onClick={() => void choose(w)}
              className="rounded-full border border-emerald-500 bg-emerald-50 px-2.5 py-1 font-bold text-emerald-800 disabled:opacity-50">
              {DEVICE_WRITER_JA[w]}
            </button>
          ))}
          <button type="button" onClick={later} className="ml-1 text-[11px] text-[#8696a0] underline">後で</button>
        </div>
      )}
    </div>
  );
}
