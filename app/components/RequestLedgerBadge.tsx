"use client";
// 会話の一覧の行に出す「確認事項 未対応 N」（2026-10-08 竹内さん「それにする。今のお客さんから」）。
// ・数はサーバー（/api/request-ledger/counts・申込前・直近14日に発言がある会話）から読むだけ。画面からサーバー専用の物は import しない
// ・会話画面の帯「お客様の確認事項（未対応 N）」と同じ数（request-ledger の buildRequestLedger・14日）
// ・2分ごと・画面に戻った時に取り直す（新着の札 useNewArrivalCounts と同じ）。戻す: NEXT_PUBLIC_REQUEST_LEDGER_BADGE=off
import { useEffect, useState } from "react";
import { LIST_CHIP, LIST_CHIP_TONE } from "@/app/lib/list-row-chip";

const ENABLED = (process.env.NEXT_PUBLIC_REQUEST_LEDGER_BADGE ?? "").trim().toLowerCase() !== "off"
  && (process.env.NEXT_PUBLIC_REQUEST_LEDGER ?? "").trim().toLowerCase() !== "off";

/** 会話 ID → 確認事項の未対応の数 */
export function useRequestLedgerCounts(): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!ENABLED) return;
    const load = async () => {
      try {
        const res = await fetch("/api/request-ledger/counts", { cache: "no-store" });
        const j = await res.json() as { ok: boolean; counts?: Record<string, number> };
        if (j.ok) setCounts(j.counts ?? {});
      } catch { /* 表示だけ */ }
    };
    void load();
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    const id = window.setInterval(tick, 120_000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(id); window.removeEventListener("focus", tick); };
  }, []);
  return counts;
}

/** 一覧の行の札（必ず・確認中と同じ並び・同じ形） */
export function RequestLedgerListBadge({ count }: { count: number | undefined }) {
  if (!ENABLED || !count) return null;
  return (
    <span className={`${LIST_CHIP} ${LIST_CHIP_TONE.request}`} title="お客様の確認事項（連投の依頼・質問）で、まだ答えていない物の数（会話画面の帯と同じ・14日）">
      確認事項 未対応 {count}
    </span>
  );
}
