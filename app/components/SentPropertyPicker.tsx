"use client";
// app/components/SentPropertyPicker.tsx
// 内覧の AIX（待ち合わせ・内覧誘導・内覧へ！）の「この会話で送った物件」の候補（見積書作成の物件の選び方と同じ材料）。
//   2026-10-06 竹内さん「待ち合わせした際 送った物件選択してそこから おこなえるようにする 物件資料の上に その候補の部分をつくる（見積書作成の時のように）」
//   2026-10-06 竹内さん「内覧誘導の部分実際に送った物件のところ 読み取って選択できるようにする」
// 値は GET /api/estimate-handoff（estimate-handoff-server.ts・読むだけ・LLM を呼ばない）。並び・先に選ぶ物は app/lib/viewing-property-candidates.ts（純関数）。
// ⚠ サーバー専用ライブラリを import しない（型と純関数だけ）
import { useEffect, useRef, useState } from "react";
import type { EstimateHandoff } from "../lib/estimate-handoff";
import { viewingCandidatesFromChoice, candidateMatchesName, type ViewingPropertyCandidate } from "../lib/viewing-property-candidates";

const INTERNAL_AUTH_HEADER = { Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` };

export default function SentPropertyPicker(props: {
  conversationId: string | null | undefined;
  /** 今欄に入っている物件（選ばれている印に使う） */
  selected: ReadonlyArray<{ name: string; room?: string | null }>;
  onToggle: (c: ViewingPropertyCandidate, select: boolean) => void;
  /** 読み込めた時に1回だけ（先に選ぶ物を親が決める） */
  onLoaded?: (cands: ViewingPropertyCandidate[]) => void;
  multiple?: boolean;
  /** 先に選んだ理由・追加の内覧の注意など（親が決めた一言） */
  note?: string;
  accent?: "sky" | "purple" | "emerald";
}) {
  const { conversationId, selected, onToggle, onLoaded, multiple, note } = props;
  const [cands, setCands] = useState<ViewingPropertyCandidate[] | null>(null);
  const [error, setError] = useState("");
  const loadedRef = useRef<string | null>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    if (!conversationId || loadedRef.current === conversationId) return;
    loadedRef.current = conversationId;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/estimate-handoff?conversation_id=${encodeURIComponent(conversationId)}`, { headers: INTERNAL_AUTH_HEADER, cache: "no-store" });
        const d = await r.json() as { ok: boolean; handoff?: EstimateHandoff };
        if (cancelled) return;
        const list = d.ok && d.handoff ? viewingCandidatesFromChoice(d.handoff.choice) : [];
        setCands(list);
        onLoadedRef.current?.(list);
      } catch {
        if (!cancelled) { setCands([]); setError("送った物件を読み込めませんでした"); }
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId]);

  if (!conversationId) return null;
  const tone = props.accent === "purple"
    ? { on: "border-[#7C3AED] bg-[#F3E8FF] text-[#5B21B6]", head: "text-[#7C3AED]" }
    : props.accent === "emerald"
    ? { on: "border-emerald-500 bg-emerald-50 text-emerald-800", head: "text-emerald-700" }
    : { on: "border-sky-500 bg-sky-50 text-sky-800", head: "text-sky-700" };

  return (
    <div className="mb-2">
      <p className={`mb-1 text-[11px] font-bold ${tone.head}`}>
        この会話で送った物件から選ぶ<span className="ml-1 font-normal text-[#8696a0]">{multiple ? "（複数選べます・押すと物件名・写真が入ります）" : "（押すと物件名・住所・資料が入ります）"}</span>
      </p>
      {cands === null ? (
        <p className="text-[11px] text-[#8696a0]">⏳ 送った物件を読み込み中...</p>
      ) : cands.length === 0 ? (
        <p className="text-[11px] text-[#8696a0]">{error || "この会話で送った物件の記録がありません（下で資料を読み込むか、手で入れてください）"}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {cands.map((c) => {
            const isOn = selected.some((s) => candidateMatchesName(c, s.name, s.room ?? null));
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => onToggle(c, !isOn)}
                title={`${c.sourceLabel}${c.address ? `\n所在地: ${c.address}` : ""}`}
                className={`flex max-w-full items-center gap-1.5 rounded-lg border px-1.5 py-1 text-left text-[11px] transition ${isOn ? tone.on : "border-[#d1d7db] bg-white text-[#3b4a54]"} ${c.ended ? "opacity-60" : ""}`}
              >
                {c.imageUrl ? (
                  <img src={c.imageUrl} alt="" className="h-7 w-7 shrink-0 rounded object-cover" />
                ) : (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-[#f0f2f5] text-[10px] text-[#8696a0]">資料</span>
                )}
                <span className="min-w-0">
                  <span className="block truncate font-bold">{isOn ? "✓ " : ""}{c.label}</span>
                  <span className="block truncate text-[10px] text-[#8696a0]">
                    {c.customerPointed ? "💬 " : ""}{c.sourceLabel}{c.ended ? "・募集終了の記録" : ""}{c.dealStatus ? `・${c.dealStatus}` : ""}{!c.address ? "・所在地なし" : !c.addressHasBanchi ? "・番地なし" : ""}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {note && <p className="mt-1 text-[10px] text-[#8696a0]">{note}</p>}
    </div>
  );
}
