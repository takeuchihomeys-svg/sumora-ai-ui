"use client";
// 売上サポの物件一覧（この会話の property_pickups・保存期間の内）から選んで、AIX【物件ピックアップした】の物件画像に足す。
// 2026-10-18 竹内さん 10/16「物件ピックアップの画像を、売上サポの物件一覧から選んで足せるようにする（1通目で束がそろわない時の入口）」。
//   画像は売上サポの handoff と同じ（GET /api/property-pickups の ids 形＝お客様に送る1ページ目だけ・説明文/AD は来ない）。
//   足した画像は行 ID と一緒に返す（AIX が今回の物件の事実を行から読む・pickup_ids_by_image）。戻す NEXT_PUBLIC_PICKUP_LIST_IMPORT=off
import { useState } from "react";
import { sameAsPreferred } from "../lib/sent-property-pick";

type Item = { id: number; rank: number; property_name: string; room_no: string | null; image_url: string | null; created_at?: string; sent_at?: string | null };
export type PickedPickup = { file: File; id: number; name: string };

// 2026-10-28 竹内さん #18: single（1件だけ選ぶ＝物件オススメ）・label（「AIX ツールから選択」）・preferName（ブレインが決めた物件に先にチェック）。どれも省略で今まで通り
export default function PickupListImport({ conversationId, onAdd, single, label, preferName }: { conversationId: string; onAdd: (picked: PickedPickup[]) => void; single?: boolean; label?: string; preferName?: string | null }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());
  if ((process.env.NEXT_PUBLIC_PICKUP_LIST_IMPORT ?? "").trim().toLowerCase() === "off" || !conversationId) return null;

  const open = async () => {
    setError(null); setBusy(true);
    try {
      const r = await fetch(`/api/property-pickups?view=handoff&conv=${encodeURIComponent(conversationId)}`, { cache: "no-store" });
      const j = (await r.json()) as { ok: boolean; items?: Item[]; error?: string };
      if (!j.ok) throw new Error(j.error ?? "読み込めませんでした");
      setItems(j.items ?? []);
      const pref = preferName ? (j.items ?? []).filter((it) => sameAsPreferred(it.property_name, it.room_no, preferName)).map((it) => it.id) : [];
      setSel(new Set(single ? pref.slice(0, 1) : pref));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const add = async () => {
    if (!items) return;
    setBusy(true); setError(null);
    const picked: PickedPickup[] = [];
    for (const it of items) {
      if (!sel.has(it.id) || !it.image_url) continue;
      try {
        const blob = await (await fetch(it.image_url)).blob();
        const name = `${it.property_name}${it.room_no ? ` ${it.room_no}` : ""}`;
        picked.push({ file: new File([blob], `${it.rank}_${it.property_name}${it.room_no ? `_${it.room_no}` : ""}.jpg`, { type: blob.type || "image/jpeg" }), id: it.id, name });
      } catch { /* その1枚は飛ばす */ }
    }
    setBusy(false);
    if (!picked.length) { setError("画像を取れませんでした"); return; }
    onAdd(picked);
    setAddedIds((prev) => new Set([...prev, ...picked.map((p) => p.id)]));
    setItems(null);
  };

  return (
    <div className="mt-2">
      {!items && (
        <button onClick={() => void open()} disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[#d1d7db] py-2.5 text-xs font-semibold text-[#54656f] hover:bg-[#f0f2f5] disabled:opacity-50">
          {busy ? "読み込み中…" : `${label ?? "📋 売上サポの物件一覧から足す"}${addedIds.size ? `（${addedIds.size}件足した）` : ""}`}
        </button>
      )}
      {items && (
        <div className="rounded-2xl border border-[#d1d7db] p-2">
          {items.length === 0 && <p className="py-2 text-center text-xs text-[#8696a0]">この会話の売上サポの物件はありません（7日以内・画像のある物）</p>}
          <div className="max-h-56 overflow-y-auto">
            {items.map((it) => (
              <label key={it.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-[#111b21] hover:bg-[#f0f2f5]">
                <input type="checkbox" checked={sel.has(it.id)} disabled={addedIds.has(it.id)}
                  onChange={() => setSel((prev) => { if (single) return prev.has(it.id) ? new Set() : new Set([it.id]); const n = new Set(prev); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); return n; })} />
                <span className="flex-1 truncate">{it.property_name}{it.room_no ? ` ${it.room_no}` : ""}</span>
                {it.sent_at && <span className="shrink-0 text-[10px] text-[#8696a0]">送付済み</span>}
                {addedIds.has(it.id) && <span className="shrink-0 text-[10px] text-[#2196F3]">足した</span>}
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button onClick={() => setItems(null)} className="flex-1 rounded-xl border border-[#d1d7db] py-2 text-xs text-[#54656f]">閉じる</button>
            <button onClick={() => void add()} disabled={busy || sel.size === 0}
              className="flex-1 rounded-xl bg-[#2196F3] py-2 text-xs font-bold text-white disabled:opacity-40">{busy ? "取り込み中…" : single ? "この物件をセット" : `${sel.size}件を足す`}</button>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-[10px] text-red-500">{error}</p>}
    </div>
  );
}
