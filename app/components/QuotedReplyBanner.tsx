"use client";
// お客様の引用返信の「引用の枠」（LINE アプリと同じく 送った人／写真＋小さなサムネイル・分かれば物件名）。
// 2026-10-07 竹内（Ryoichi kiritsuke）: 「↩ [引用] [画像]」としか出ず、どの物件を指したか分からなかった。
//   中身を決めるのは app/lib/quote-preview.ts（純関数）。ここは引用先を読む所と描くところだけ。
// ・物件名は送った時の記録（sent_image_properties → sent_properties）だけ。ブレイン（brain-core）・返信生成（quoted-context）と同じ出所＝推測しない
// ・押す → 引用元の吹き出しへ移って光らせる。引用元が画面に無い（古い等）時は画像を大きく出す
import { useEffect, useState } from "react";
import { supabase } from "@/app/lib/supabase";
import { buildQuotePreview, labelsFromSentRows, type QuotedSource } from "@/app/lib/quote-preview";

/** 引用 ID（LINE の message id＝messages.line_message_id）→ 引用先。会話・引用 ID が変わるたびに読み直す */
export function useQuotedMessages(conversationId: string | null | undefined, quotedIdsKey: string): Map<string, QuotedSource> {
  const [state, setState] = useState<{ key: string; map: Map<string, QuotedSource> }>({ key: "", map: new Map() });
  const key = `${conversationId ?? ""}|${quotedIdsKey}`;
  useEffect(() => {
    if (!conversationId || !quotedIdsKey) return;
    const quotedIds = quotedIdsKey.split(",");
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("messages")
        .select("line_message_id, sender, text, image_url, image_expires_at")
        .in("line_message_id", quotedIds);
      if (cancelled || !data) return;
      const rows = data as Array<{ line_message_id: string | null; sender: string | null; text: string | null; image_url: string | null; image_expires_at: string | null }>;
      // 引用先がこちらの送った画像なら、どの物件の資料か（送った時の記録）
      const urls = [...new Set(rows.filter((r) => r.sender !== "customer" && !!r.image_url).map((r) => r.image_url as string))];
      let labels = new Map<string, string>();
      if (urls.length > 0) {
        try {
          // ⚠ URL は1本150字ほど。in() に何十本も並べると GET の URL が長すぎて黙って空になる（監査で 124枚中 7枚しか名前が出なかった）→ 20本ずつ
          type Row = { image_url: string | null; property_name: string | null; room_no: string | null };
          const chunks: string[][] = [];
          for (let i = 0; i < urls.length; i += 20) chunks.push(urls.slice(i, i + 20));
          const read = (table: "sent_image_properties" | "sent_properties") => Promise.all(chunks.map((c) =>
            supabase.from(table).select("image_url, property_name, room_no").eq("conversation_id", conversationId).in("image_url", c)
              .then(({ data }) => (data ?? []) as Row[])));
          const [a, b] = await Promise.all([read("sent_image_properties"), read("sent_properties")]);
          labels = labelsFromSentRows([...a.flat(), ...b.flat()]);
        } catch { /* 物件名は出せないだけ（サムネイルは出す） */ }
      }
      if (cancelled) return;
      const map = new Map<string, QuotedSource>();
      for (const r of rows) {
        if (!r.line_message_id) continue;
        map.set(r.line_message_id, {
          sender: r.sender, text: r.text, imageUrl: r.image_url, imageExpiresAt: r.image_expires_at,
          propertyLabel: r.image_url ? labels.get(r.image_url) ?? null : null,
        });
      }
      setState({ key: `${conversationId}|${quotedIdsKey}`, map });
    })();
    return () => { cancelled = true; };
  }, [conversationId, quotedIdsKey]);
  // 別の会話に移った直後に前の会話の引用を出さない
  return state.key === key ? state.map : EMPTY;
}
const EMPTY = new Map<string, QuotedSource>();

/** 引用元の吹き出し（id="msg-…"）へ移って 0.8秒光らせる。見つからなければ false */
function jumpTo(targetMsgId: string | undefined): boolean {
  if (!targetMsgId) return false;
  const el = document.getElementById(`msg-${targetMsgId}`);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.style.transition = "background-color 0.1s";
  el.style.backgroundColor = "rgba(255, 220, 100, 0.5)";
  setTimeout(() => { el.style.backgroundColor = ""; }, 800);
  return true;
}

export function QuotedReplyBanner({ source, targetMsgId, account, customerName, onOpenImage }: {
  source: QuotedSource | undefined;
  /** 引用元の吹き出しの id（画面にあれば） */
  targetMsgId: string | undefined;
  account?: string | null;
  customerName?: string | null;
  onOpenImage: (url: string) => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const p = buildQuotePreview(source, { account, customerName });
  if (p.kind === "missing") {
    return (
      <div className="mb-1 flex items-start gap-1 rounded border-l-2 border-gray-300 bg-gray-100 px-2 py-1 text-[11px] text-gray-400">
        <span className="shrink-0">↩ 引用</span>
        <span className="truncate">（引用元のメッセージが見つかりません）</span>
      </div>
    );
  }
  const thumb = p.thumbUrl && !thumbFailed ? p.thumbUrl : null;
  const gone = p.imageGone || (!!p.thumbUrl && thumbFailed);
  const clickable = !!targetMsgId || !!thumb;
  const onClick = () => { if (!jumpTo(targetMsgId) && thumb) onOpenImage(thumb); };
  return (
    <div
      role={clickable ? "button" : undefined}
      onClick={clickable ? onClick : undefined}
      title={targetMsgId ? "タップして引用元のメッセージに移動" : thumb ? "タップして画像を大きく見る" : undefined}
      className={`mb-1 flex items-stretch gap-2 rounded-lg border-l-[3px] bg-[#f0f2f5] py-1 pl-2 pr-1 text-[11px] text-[#54656f] ${clickable ? "cursor-pointer border-[#06c755] hover:bg-[#e7f6ec] active:bg-[#d6f0de]" : "border-gray-300"}`}
    >
      <div className="min-w-0 flex-1 py-0.5">
        <div className="truncate font-bold text-[#3d4a52]">↩ {p.who}</div>
        <div className="truncate">{gone ? `${p.snippet}（保存切れ）` : p.snippet}</div>
        {p.propertyLabel && (
          <div className="mt-0.5 truncate font-bold text-[#0d47a1]" title="送った時の記録から（どの物件の資料か）">🏠 {p.propertyLabel}</div>
        )}
      </div>
      {thumb ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenImage(thumb); }}
          className="shrink-0 overflow-hidden rounded-md bg-white ring-1 ring-[#d1d7db]"
          title="画像を大きく見る"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb} alt={p.propertyLabel ? `${p.propertyLabel} の資料` : "引用した画像"} loading="lazy" onError={() => setThumbFailed(true)} className="block h-[48px] w-[48px] object-cover object-top" />
        </button>
      ) : (p.kind === "image" || p.kind === "video") ? (
        <div className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-md bg-white text-[18px] text-[#b0bec5] ring-1 ring-[#d1d7db]">{p.kind === "video" ? "🎬" : "🖼"}</div>
      ) : null}
    </div>
  );
}
