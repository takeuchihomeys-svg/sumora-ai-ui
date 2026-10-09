"use client";
// app/components/PromiseQueueBar.tsx — 会話画面「約束の続き」: 1通で複数を約束した時の、次に送る AIX と残り（promise-queue）
//   2026-10-09 竹内さん「読み込んで約束して、約束した事を記録して、それを AIX で送っていけば完全にできる」。
//   値は GET /api/promise-queue（LLM なし）。次が無ければ出さない。失敗しても画面は落とさない。入れる: NEXT_PUBLIC_PROMISE_QUEUE=on（既定 off）
import { useEffect, useRef, useState } from "react";

type View = { next: string | null; rest: string[]; done: string[] };
type Props = { conversationId: string; refreshKey: string; authHeader: Record<string, string> };

export default function PromiseQueueBar({ conversationId, refreshKey, authHeader }: Props) {
  const [v, setV] = useState<View | null>(null);
  const authRef = useRef(authHeader);
  authRef.current = authHeader;
  useEffect(() => {
    setV(null);
    if (!conversationId || process.env.NEXT_PUBLIC_PROMISE_QUEUE !== "on") return;
    const ac = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/promise-queue?conversation_id=${encodeURIComponent(conversationId)}`, { headers: authRef.current, signal: ac.signal, cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { ok?: boolean } & View;
        if (ac.signal.aborted || !j.ok || !j.next) return;
        setV({ next: j.next, rest: j.rest ?? [], done: j.done ?? [] });
      } catch { /* 出さないだけ */ }
    })();
    return () => ac.abort();
  }, [conversationId, refreshKey]);
  if (!v?.next) return null;
  return (
    <div className="border-b border-[#b39ddb] px-4 py-2" style={{ background: "linear-gradient(90deg, #ede7f6, #f8f5ff)" }}>
      <p className="text-[11px] font-bold text-[#4527a0]">約束の続き{v.rest.length ? `（残り ${v.rest.length + 1}）` : ""}</p>
      <div className="flex items-start gap-2">
        <span className="shrink-0 rounded-full bg-[#5e35b1] px-1.5 py-0.5 text-[9px] font-bold text-white">次</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-[#311b92]">{v.next}</span>
      </div>
      {v.rest.map((x, n) => (
        <div key={n} className="flex items-start gap-2">
          <span className="shrink-0 rounded-full bg-[#9575cd] px-1.5 py-0.5 text-[9px] font-bold text-white">その後</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#4527a0]">{x}</span>
        </div>
      ))}
      {v.done.length > 0 && <p className="mt-0.5 truncate text-[10px] text-[#7e57c2]">済み: {v.done.join("・")}</p>}
    </div>
  );
}
