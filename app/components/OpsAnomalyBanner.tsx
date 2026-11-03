"use client";
// app/components/OpsAnomalyBanner.tsx — 本番の異常の知らせの画面の上の印（案B・2026-11-03 作業員1）
//   NEXT_PUBLIC_OPS_ANOMALY_BANNER=on の時だけ出す（既定 off＝読みにも行かない）。2分ごとに /api/ops-anomalies を読む。
//   押すと30分しまう（この端末だけ）。中身は種類と件数だけ（お客様の情報は出さない）
import { useEffect, useState } from "react";

type Item = { kind: string; label: string; severity: string; why: string; first_seen_at: string };
const ON = process.env.NEXT_PUBLIC_OPS_ANOMALY_BANNER === "on";
const HIDE_KEY = "opsAnomalyHiddenUntil";

export default function OpsAnomalyBanner() {
  const [items, setItems] = useState<Item[]>([]);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!ON) return;
    try { const u = Number(localStorage.getItem(HIDE_KEY) ?? "0"); if (u > Date.now()) setHidden(true); } catch { /* */ }
    let alive = true;
    const load = async () => {
      try { const r = await fetch("/api/ops-anomalies", { cache: "no-store" }); const j = (await r.json()) as { items?: Item[] }; if (alive) setItems(j.items ?? []); } catch { /* */ }
    };
    void load();
    const t = setInterval(load, 120_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!ON || hidden || !items.length) return null;
  const high = items.some((i) => i.severity === "high");
  const hm = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(11, 16);
  return (
    <div
      role="alert"
      onClick={() => { setHidden(true); try { localStorage.setItem(HIDE_KEY, String(Date.now() + 30 * 60_000)); } catch { /* */ } }}
      style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999, padding: "4px 12px", fontSize: 12, lineHeight: 1.4, color: high ? "#fff" : "#5c3b00", background: high ? "#d93025" : "#fde68a", textAlign: "center", cursor: "pointer", paddingTop: "max(4px, env(safe-area-inset-top))" }}
    >
      ⚠ 本番の異常: {items.map((i) => `${i.label}（${hm(i.first_seen_at)}〜）`).join("・")}　<span style={{ opacity: 0.75 }}>押すと30分しまう</span>
    </div>
  );
}
