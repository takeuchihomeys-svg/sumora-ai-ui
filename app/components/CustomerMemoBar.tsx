"use client";
// app/components/CustomerMemoBar.tsx — お客様のメモ（人の営業のメモ帳）の帯。普段は1行（件数と気持ち）・押すと短い箇条（出所つき）
//   2026-10-08 竹内さん「人間でいうメモが必要」: スタッフも読める形・間違いをスタッフが直せる（直した物は手で付けた印＝DeepSeek が上書きしない）。
//   値は GET/POST /api/customer-memo（LLM なし）。失敗しても画面は落とさない。戻す: NEXT_PUBLIC_CUSTOMER_MEMO=off
import { useEffect, useRef, useState } from "react";

type Row = { id: string; kind: string; label: string; text: string; source: string; origin: "llm" | "staff" | "rule"; locked: boolean };
type Mood = { hint: string; changes: string[]; prevEmotions: string[] };
// 2026-10-21 竹内さんの決定（70193195・c2909936）: 申込歴あり（再探し）と戻った理由。帯の頭に小さな札・開くと理由をスタッフが選べる
type Reapply = { pattern: string; label: string; badge: string; source: "staff" | "auto" | "none"; returnedAt: string | null };
const REAPPLY_OPTIONS: Array<[string, string]> = [
  ["screening_denied", "①審査否決"], ["lost_to_first", "②番手で1番手が審査通過（お部屋が取れなかった）"], ["switched", "③別の物件に切り替え"], ["unknown", "理由不明"],
];
// 2026-10-21 竹内さんの決定（ec4d5990）: 2番手で申込中（並行で探す）。今も申込中の会話だけ。札（同じ帯の頭）・開くとスタッフが選べる（はい／いいえ／自動）
type Parallel = { active: boolean; eligible: boolean; source: "staff" | "auto" | null; label: string };
type Props = { conversationId: string; refreshKey: string; authHeader: Record<string, string> };

const KINDS: Array<[string, string]> = [
  ["core", "条件の芯"], ["flexible", "妥協できる所"], ["circumstance", "事情・予定"], ["people", "決める人・同居"], ["concern", "気にしている事"],
  ["like", "好き・気に入った"], ["ng", "NG・嫌い"], ["style", "言葉づかい"], ["told", "こちらが伝えた事"], ["asked", "聞かれた事"],
  ["decide_gap", "決め手の残り（あと1点で決まる）"],
];

export default function CustomerMemoBar({ conversationId, refreshKey, authHeader }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [mood, setMood] = useState<Mood | null>(null);
  // 2026-10-16 竹内悠馬「背景の読みをメモ欄に1行で」: ブレインの答える前の整理（turn_contract.background）。戻す NEXT_PUBLIC_TURN_BACKGROUND_MEMO=off
  const [background, setBackground] = useState<string | null>(null);
  const [reapply, setReapply] = useState<Reapply | null>(null);
  const [parallel, setParallel] = useState<Parallel | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [addKind, setAddKind] = useState("concern");
  const [tick, setTick] = useState(0);
  const authRef = useRef(authHeader);
  authRef.current = authHeader;

  useEffect(() => {
    setRows([]); setMood(null); setBackground(null); setReapply(null); setParallel(null);
    if (!conversationId || process.env.NEXT_PUBLIC_CUSTOMER_MEMO === "off") return;
    const ac = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/customer-memo?conversation_id=${encodeURIComponent(conversationId)}`, { headers: authRef.current, signal: ac.signal, cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { ok?: boolean; rows?: Row[]; mood?: Mood | null; background?: { text: string } | null; reapply?: Reapply | null; parallel?: Parallel | null };
        if (ac.signal.aborted || !j.ok) return;
        setRows(j.rows ?? []); setMood(j.mood ?? null); setReapply(j.reapply ?? null); setParallel(j.parallel ?? null);
        setBackground(process.env.NEXT_PUBLIC_TURN_BACKGROUND_MEMO === "off" ? null : j.background?.text ?? null);
      } catch { /* 出さないだけ */ }
    })();
    return () => ac.abort();
  }, [conversationId, refreshKey, tick]);

  useEffect(() => { setOpen(false); setEditing(null); }, [conversationId]);

  if (process.env.NEXT_PUBLIC_CUSTOMER_MEMO === "off") return null;
  const memoRows = rows.filter((r) => r.origin !== "rule");
  const toldRows = rows.filter((r) => r.origin === "rule");
  if (!memoRows.length && !toldRows.length && !mood && !background && !reapply && !parallel?.eligible) return null;

  const post = async (body: Record<string, unknown>) => {
    try {
      const r = await fetch("/api/customer-memo", { method: "POST", headers: { ...authRef.current, "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: conversationId, ...body }) });
      if (r.ok) setTick((t) => t + 1);
    } catch { /* 直せなかった */ }
  };
  const moodText = mood ? `${mood.prevEmotions.length ? `${mood.prevEmotions.join("→")}／` : ""}今回の見立て: ${mood.hint}` : "";

  return (
    <div className="border-b border-[#c5cae9] bg-[#f5f6ff] px-3 py-1.5 md:px-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <span className="shrink-0 rounded-full bg-[#3949ab] px-1.5 py-0.5 text-[9px] font-bold text-white">メモ</span>
        {reapply && <span className="shrink-0 rounded-full bg-orange-500 px-1.5 py-0.5 text-[9px] font-bold text-white" title="一度申込まで進んで物件探しに戻ったお客様（アツいお客様）">{reapply.badge}</span>}
        {parallel?.active && <span className="shrink-0 rounded-full bg-sky-600 px-1.5 py-0.5 text-[9px] font-bold text-white" title="1番手の方が審査中のお部屋に2番手で申込み、並行して別の物件を探しているお客様（下書き・AIX は止めない・申込フォームの値は伏せてから DeepSeek に渡す）">{parallel.label}</span>}
        <span className="min-w-0 flex-1 truncate text-[11px] text-[#283593]">
          {memoRows.length ? `${memoRows.length}件` : "まだ無し"}{toldRows.length ? `・もう伝えた ${toldRows.length}種類` : ""}{moodText ? `・気持ち ${moodText}` : ""}{background ? `・背景 ${background}` : ""}
        </span>
        <span className="text-[10px] text-[#5c6bc0]">{open ? "閉じる" : "開く"}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 pl-[42px]">
          {reapply && (
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="shrink-0 font-bold text-orange-700">【申込歴あり】</span>
              <span className="text-orange-900">戻った理由</span>
              <select
                value={reapply.pattern}
                onChange={(e) => { void post({ op: "set_reapply_pattern", pattern: e.target.value }); }}
                className="rounded border border-orange-300 bg-white text-[10px] text-orange-900"
              >
                {REAPPLY_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <span className="text-[10px] text-[#7986cb]">{reapply.source === "staff" ? "スタッフが選んだ" : reapply.source === "auto" ? "会話の記録から" : "会話から読めない"}</span>
              {reapply.source === "staff" && <button type="button" className="text-[10px] text-[#5c6bc0] underline" onClick={() => { void post({ op: "set_reapply_pattern", pattern: null }); }}>自動に戻す</button>}
            </div>
          )}
          {parallel?.eligible && (
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="shrink-0 font-bold text-sky-700">{parallel.label}:</span>
              <select
                value={parallel.source === "staff" ? (parallel.active ? "on" : "off") : "auto"}
                onChange={(e) => { const v = e.target.value; void post({ op: "set_parallel_2nd", on: v === "on" ? true : v === "off" ? false : null }); }}
                className="rounded border border-sky-300 bg-white text-[10px] text-sky-900"
              >
                <option value="auto">自動（会話の記録から）{parallel.source !== "staff" ? `：${parallel.active ? "はい" : "いいえ"}` : ""}</option>
                <option value="on">はい（並行で探す）</option>
                <option value="off">いいえ</option>
              </select>
            </div>
          )}
          {background && <p className="text-[11px] text-[#4a148c]"><span className="font-bold">背景の読み（ブレイン）:</span> {background}</p>}
          {mood && mood.changes.length > 0 && <p className="text-[10px] text-[#6a1b9a]">流れ: {mood.changes.join("／")}</p>}
          {memoRows.map((r) => (
            <div key={r.id} className="flex items-start gap-1 text-[11px]">
              <span className="shrink-0 font-bold text-[#3949ab]">{r.label}:</span>
              {editing === r.id ? (
                <span className="flex flex-1 gap-1">
                  <input value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} className="min-w-0 flex-1 rounded border border-[#9fa8da] px-1 text-[11px]" />
                  <button type="button" className="text-[10px] text-[#3949ab] underline" onClick={() => { void post({ op: "update", id: r.id, text: draft }); setEditing(null); }}>保存</button>
                </span>
              ) : (
                <span className="min-w-0 flex-1">
                  <span className="text-[#1a237e]">{r.text}</span>
                  {r.locked && <span className="ml-1 rounded bg-[#e8eaf6] px-1 text-[9px] text-[#3949ab]">手で直した</span>}
                  <span className="ml-1 text-[10px] text-[#7986cb]">{r.source}</span>
                  <button type="button" className="ml-1 text-[10px] text-[#5c6bc0] underline" onClick={() => { setEditing(r.id); setDraft(r.text.replace(/（たぶん）$/, "")); }}>直す</button>
                  <button type="button" className="ml-1 text-[10px] text-[#c62828] underline" onClick={() => { void post({ op: "retire", id: r.id }); }}>違う</button>
                </span>
              )}
            </div>
          ))}
          {toldRows.length > 0 && (
            <p className="text-[10px] text-[#455a64]">
              もう伝えた: {toldRows.map((r) => (
                <span key={r.id} className="mr-1.5 inline-block">{r.text}（{r.source}）<button type="button" className="text-[#c62828] underline" onClick={() => { void post({ op: "hide_rule", id: r.id }); }}>×</button></span>
              ))}
            </p>
          )}
          <div className="flex items-center gap-1 pt-0.5">
            <select value={addKind} onChange={(e) => setAddKind(e.target.value)} className="rounded border border-[#9fa8da] bg-white text-[10px]">
              {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input value={editing === "__new" ? draft : ""} onFocus={() => { setEditing("__new"); setDraft(""); }} onChange={(e) => setDraft(e.target.value)} maxLength={60} placeholder="メモを足す（60字まで）" className="min-w-0 flex-1 rounded border border-[#9fa8da] px-1 text-[11px]" />
            <button type="button" disabled={editing !== "__new" || !draft.trim()} className="rounded-full bg-[#3949ab] px-2 py-0.5 text-[10px] font-bold text-white disabled:opacity-40" onClick={() => { void post({ op: "add", kind: addKind, text: draft }); setEditing(null); setDraft(""); }}>足す</button>
          </div>
        </div>
      )}
    </div>
  );
}
