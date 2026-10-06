"use client";
// LINE のトーク画面に挟む「新着物件カード」（スタッフだけに見える・お客様には絶対出ない）。
// 2026-09-27 竹内「ブレインの検索 → AIXツール（売上サポ）で採点された新着物件を、トーク画面に折りたたみで出す。
//   中身は拡張で検索した条件＋件数（通す・保留）・新規／新着／広げて等。押したら AIXツールのそのグループへ。確認したかが分かるように」
// ・中身は /api/property-pickups/talk（AIXツールと同じ property_pickups・search_audits を読むだけ）→ app/lib/new-arrival-card.ts
// ・このカードは messages に入れない（React の表示だけ）＝LINE 送信・下書き・ブレインの材料に混ざらない
// ・押す → AIXツール（/conditions?pickup=…&batch=…）を別タブで開き、その回へ移る。同時に既読（seen_at）を入れる＝確認済み
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cardsBetween, cardHeadline, confirmLabel, pickupReviewHref, type NewArrivalCard } from "@/app/lib/new-arrival-card";
import { LIST_CHIP, LIST_CHIP_TONE } from "@/app/lib/list-row-chip";

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

/** トーク一覧の行に出す「新着 N件・未確認」
 *  2026-10-01 竹内「重要な部分だけのこす・洗練させる」: 一覧の札の形（list-row-chip）に揃え、🆕 の絵文字を外す。
 *  数は未確認の分だけなので「未確認」は残す（行の2段目・本文の前に並ぶ） */
export function NewArrivalListBadge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <span className={`${LIST_CHIP} ${LIST_CHIP_TONE.newArrival}`} title="AIXツールで採点した新着物件・未確認（スタッフだけの表示）">
      新着 {count}件・未確認
    </span>
  );
}

/** トーク画面の日付の区切りと同じ文字（page.tsx の msgDate と同じ書き方） */
export function talkDateLabel(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" }) : "";
}
/** 送信メッセージの横の時刻と同じ形（HH:MM） */
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 時系列の1か所（prevAt より後・curAt 以前）に入るカードを、日付の区切りごと並べる。curAt=null は最後の吹き出しの後ろ。
 * 2026-09-27 竹内「そのタイミングでトークのところで日時、自分の部分で出たら分かりやすい」
 * ・カードはスタッフの吹き出しと同じ右側・横に時刻。日付が変わる所は既存の日付の区切りと同じ物を出す
 * ・lastDate（トークで直前に出した日付）を受け、出した後の lastDate を返す＝次の吹き出しが区切りを二重に出さない
 *   （旧: カードは次の吹き出しの日付の区切りより上に出たため、日をまたぐと前の日の下に並んでいた）
 */
export function newArrivalElems(talk: NewArrivalTalk, prevAt: string | null | undefined, curAt: string | null | undefined, lastDate: string, keyBase: string): { elems: ReactNode[]; lastDate: string } {
  const hit = cardsBetween(talk.cards, prevAt, curAt).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const elems: ReactNode[] = [];
  let last = lastDate;
  for (const c of hit) {
    const d = talkDateLabel(c.at);
    if (d && d !== last) {
      last = d;
      elems.push(
        <div key={`${keyBase}-date-${c.key}`} className="flex items-center gap-3 py-2">
          <div className="h-px flex-1 bg-[#e9edef]" />
          <span className="rounded-full bg-[#e9edef] px-3 py-1 text-[11px] text-[#8696a0]">{d}</span>
          <div className="h-px flex-1 bg-[#e9edef]" />
        </div>
      );
    }
    elems.push(<OneCard key={`${keyBase}-${c.key}`} card={c} talk={talk} />);
  }
  return { elems, lastDate: last };
}

/** AIXツール（売上サポ＝PickupReview）のこのお客様・この回を開く。スマホの指でも押せる高さ（32px）・札の青に合わせる */
function OpenAixButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      title={disabled ? "このお客様の売上サポが見つかりません" : "AIXツール（売上サポ）でこのお客様・この回を開く"}
      className="mt-1 inline-flex min-h-[32px] items-center gap-1 rounded-full border border-[#90caf9] bg-white px-3 text-[11px] font-bold text-[#1565C0] active:bg-[#e3f2fd] disabled:opacity-40"
    >
      AIXツールで開く ↗
    </button>
  );
}

function OneCard({ card, talk }: { card: NewArrivalCard; talk: NewArrivalTalk }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(false);
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
  // スタッフの吹き出しと同じ並び（右寄せ・時刻は吹き出しの左下・右下の角だけ小さく）。
  // 青い点線の枠と🔒で「スタッフだけの表示」と分かるようにする（お客様の LINE には出ない）
  return (
    <div className="flex flex-col items-end gap-0.5" data-staff-only="new-arrival">
      <div className="flex w-full items-end justify-end gap-1">
        <span className="mb-0.5 shrink-0 text-[10px] leading-none text-[#667781]">{hhmm(card.at)}</span>
        <div className="min-w-0 max-w-[86%] md:max-w-[74%] rounded-2xl rounded-br-md border border-dashed border-[#90caf9] bg-[#f5faff] px-3 py-2 text-[11px] text-[#37474f] shadow-sm">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left">
          <span className="min-w-0 flex-1 basis-[9rem] break-words font-bold text-[#0d47a1]">{cardHeadline(card)}</span>
          <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold" style={toneStyle}>{cf.text}</span>
          <span className="shrink-0 text-[#90a4ae]">{open ? "▲" : "▼"}</span>
        </button>
        {/* 物件オススメの回（1件を推す形）だけ資料の画像を小さく出す（押すと大きく）。物件ピックアップ（複数件）の回は件数だけ。
            2026-09-27 竹内「新着物件もオススメだけは資料も表示されていたら分かりやすい／物件ピックアップは件数が表示されていればよい」 */}
        {card.recommend && (
          <div className="mt-1.5 flex items-start gap-2">
            {card.recommend.image ? (
              <button type="button" onClick={() => setZoom(true)} className="shrink-0 overflow-hidden rounded-md bg-white ring-1 ring-[#cfd8dc]" title="資料を大きく見る">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={card.recommend.image} alt={`${card.recommend.name} の資料`} loading="lazy" className="block h-[88px] w-[64px] object-cover object-top" />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="text-[9px] font-bold text-[#e65100]">🏠 物件オススメ</div>
              <div className="break-words text-[12px] font-bold text-[#263238]">{card.recommend.name}{card.recommend.room_no ? ` ${card.recommend.room_no}` : ""}</div>
              {/* 2026-10-07 竹内（Ryoichi kiritsuke）: 物件名の下の空いている所に「AIXツールで開く」（▼を開かなくても押せる） */}
              <OpenAixButton onClick={go} disabled={!talk.focus} />
            </div>
          </div>
        )}
        {zoom && card.recommend?.image && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-3" onClick={() => setZoom(false)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={card.recommend.image} alt={`${card.recommend.name} の資料`} className="max-h-full max-w-full rounded bg-white object-contain" />
          </div>
        )}
        {/* 2026-10-01 竹内「検索結果はリアプロ・ITANDI をやったのか、ピンポイント検索と広げて検索をそれぞれ行ったのか、スタンプ式で」 */}
        {card.stamps && card.stamps.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {card.stamps.map((s) => (
              <span key={s.site} className="inline-flex items-center gap-0.5 rounded-full bg-white px-1.5 py-[1px] text-[10px] ring-1 ring-[#cfd8dc]" title={`${s.label}: ピンポイント ${s.pinpoint ? "済" : "未"}・広げて ${s.widen ? "済" : "未"}`}>
                <span className="font-bold text-[#455a64]">{s.label}</span>
                <span className={s.pinpoint ? "text-[#2e7d32]" : "text-[#b0bec5]"}>🎯{s.pinpoint ? "済" : "未"}</span>
                <span className={s.widen ? "text-[#2e7d32]" : "text-[#b0bec5]"}>🔎{s.widen ? "済" : "未"}</span>
              </span>
            ))}
          </div>
        )}
        {card.target && card.target.short > 0 && (
          <div className="mt-1 text-[10px] font-bold text-[#c62828]">⚠ {card.target.label}に 送れる通す {card.target.pass}件・あと {card.target.short}件{card.target.deal ? `（商談中・審査中の通す ${card.target.deal}件は送れないので数えない）` : ""}</div>
        )}
        {/* 物件オススメの無い回（物件ピックアップ）は物件名が無いので、札の下に同じボタン */}
        {!card.recommend && <OpenAixButton onClick={go} disabled={!talk.focus} />}
        <div className="mt-0.5 text-[9px] text-[#90a4ae]">🔒 スタッフだけの表示（お客様には届きません）</div>
        {open && (
          <div className="mt-1.5 space-y-1">
            {card.kinds.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {card.kinds.map((k) => <span key={k} className="rounded bg-white px-1.5 py-[1px] text-[10px] font-bold text-[#455a64] ring-1 ring-[#cfd8dc]">{k}</span>)}
              </div>
            )}
            <div><span className="text-[#78909c]">検索した条件: </span>{card.condition ?? "（点検の記録なし）"}</div>
            <div><span className="text-[#78909c]">件数: </span>全{card.total}件（通す {card.pass}・保留 {card.hold}{card.drop ? `・外す候補 ${card.drop}` : ""}）</div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
