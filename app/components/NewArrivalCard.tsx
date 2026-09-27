"use client";
// LINE のトーク画面に挟む「新着物件カード」（スタッフだけに見える・お客様には絶対出ない）。
// 2026-09-27 竹内「ブレインの検索 → AIXツール（売上サポ）で採点された新着物件を、トーク画面に折りたたみで出す。
//   中身は拡張で検索した条件＋件数（通す・保留）・新規／新着／広げて等。押したら AIXツールのそのグループへ。確認したかが分かるように」
// ・中身は /api/property-pickups/talk（AIXツールと同じ property_pickups・search_audits を読むだけ）→ app/lib/new-arrival-card.ts
// ・このカードは messages に入れない（React の表示だけ）＝LINE 送信・下書き・ブレインの材料に混ざらない
// ・押す → AIXツール（/conditions?pickup=…&batch=…）を別タブで開き、その回へ移る。同時に既読（seen_at）を入れる＝確認済み
import { useCallback, useEffect, useState } from "react";
import { cardsBetween, cardHeadline, confirmLabel, pickupReviewHref, type NewArrivalCard } from "@/app/lib/new-arrival-card";

const AUTH = { Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` };

function fmt(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type NewArrivalTalk = { cards: NewArrivalCard[]; focus: string | null; reload: () => void };

/** 開いている会話の新着物件カード（60秒ごと・画面に戻った時に取り直す＝AIXツールで開いた・送った印が付く） */
export function useNewArrivalCards(conversationId: string | null | undefined): NewArrivalTalk {
  const [state, setState] = useState<{ conv: string | null; cards: NewArrivalCard[]; focus: string | null }>({ conv: null, cards: [], focus: null });
  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/property-pickups/talk?conv=${encodeURIComponent(conversationId)}`, { cache: "no-store" });
      const j = await res.json() as { ok: boolean; cards?: NewArrivalCard[]; focus?: string | null };
      if (j.ok) setState({ conv: conversationId, cards: j.cards ?? [], focus: j.focus ?? null });
    } catch { /* 表示だけ。次の取り直しで戻る */ }
  }, [conversationId]);
  useEffect(() => {
    void load();
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    const id = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(id); window.removeEventListener("focus", tick); };
  }, [load]);
  // 別の会話に移った直後に前の会話のカードを出さない
  const mine = state.conv === conversationId;
  return { cards: mine ? state.cards : [], focus: mine ? state.focus : null, reload: () => void load() };
}

/** トーク一覧の印（会話 ID → 新着の数）。2分ごと・画面に戻った時に取り直す */
export function useNewArrivalCounts(): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/property-pickups/talk?view=counts", { cache: "no-store" });
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

/** トーク一覧の行に出す「🆕 新着 N件・未確認」 */
export function NewArrivalListBadge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <span className="w-fit self-start shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold" style={{ background: "#fff3e0", color: "#e65100" }} title="AIXツールで採点した新着物件（スタッフだけの表示）">
      🆕 新着 {count}件・未確認
    </span>
  );
}

/** 時系列の1か所（prevAt より後・curAt 以前）に入るカード。curAt=null は最後の吹き出しの後ろ */
export function NewArrivalCardSlot({ talk, prevAt, curAt }: { talk: NewArrivalTalk; prevAt: string | null | undefined; curAt: string | null | undefined }) {
  const hit = cardsBetween(talk.cards, prevAt, curAt);
  if (!hit.length) return null;
  return <>{hit.map((c) => <OneCard key={c.key} card={c} talk={talk} />)}</>;
}

function OneCard({ card, talk }: { card: NewArrivalCard; talk: NewArrivalTalk }) {
  const [open, setOpen] = useState(false);
  const cf = confirmLabel(card.confirm, fmt);
  const toneStyle = cf.tone === "warn" ? { background: "#ffebee", color: "#c62828" } : cf.tone === "ok" ? { background: "#e8f5e9", color: "#1b5e20" } : { background: "#eceff1", color: "#607d8b" };
  const go = () => {
    if (!talk.focus) return;
    window.open(pickupReviewHref(talk.focus, card.key), "_blank", "noopener");
    // AIXツールで開いた＝確認（既読はスタッフ全員で共有・通すの未読だけに入る・冪等）
    const isConv = talk.focus.startsWith("conv:");
    void fetch("/api/property-pickups/seen", {
      method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify(isConv ? { conversation_id: talk.focus.slice(5), seen_by: "talk_card" } : { property_customer_id: talk.focus, seen_by: "talk_card" }),
    }).then(() => talk.reload()).catch(() => { /* 次の取り直しで戻る */ });
  };
  return (
    <div className="flex justify-center" data-staff-only="new-arrival">
      <div className="w-full max-w-[520px] rounded-xl border border-dashed border-[#90caf9] bg-[#f5faff] px-3 py-2 text-[11px] text-[#37474f]">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
          <span className="min-w-0 flex-1 truncate font-bold text-[#0d47a1]">{cardHeadline(card)}</span>
          <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold" style={toneStyle}>{cf.text}</span>
          <span className="shrink-0 text-[#90a4ae]">{open ? "▲" : "▼"}</span>
        </button>
        <div className="mt-0.5 text-[9px] text-[#90a4ae]">🔒 スタッフだけの表示（お客様には届きません）・{fmt(card.at)}</div>
        {open && (
          <div className="mt-1.5 space-y-1">
            {card.kinds.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {card.kinds.map((k) => <span key={k} className="rounded bg-white px-1.5 py-[1px] text-[10px] font-bold text-[#455a64] ring-1 ring-[#cfd8dc]">{k}</span>)}
              </div>
            )}
            <div><span className="text-[#78909c]">検索した条件: </span>{card.condition ?? "（点検の記録なし）"}</div>
            <div><span className="text-[#78909c]">件数: </span>全{card.total}件（通す {card.pass}・保留 {card.hold}{card.drop ? `・外す候補 ${card.drop}` : ""}）</div>
            <button type="button" onClick={go} disabled={!talk.focus} className="mt-1 rounded-full bg-[#1565C0] px-3 py-1 text-[11px] font-bold text-white active:opacity-70 disabled:opacity-40">
              AIXツールでこの回を開く ↗
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
