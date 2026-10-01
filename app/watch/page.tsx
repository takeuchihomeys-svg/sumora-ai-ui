"use client";
// app/watch/page.tsx — LINE の見張り（1段目・読むだけ）
// 2026-10-01 竹内「LINE の監視の部分にうつる、自動で行って YUMA でテスト」／9/29「LINE 一覧も監視する画面があれば更によくなる・自動返信にしていくため」
// 設計 line-watch-design.md §6。上から重い順: 今待っているお客様 → AI の案と実際 → 約束の未対応 → AIX要対応 → カレンダー → 物件検索。
// ここは /api/line-watch を読んで描くだけ（書き込み・送信はしない。サーバー専用の物は型しか import しない）
import { useCallback, useEffect, useState, type ReactNode } from "react";
import BottomNav from "../components/BottomNav";
import type { LineWatchPayload } from "../lib/line-watch-server";

type Section = "daily" | "waiting" | "turns" | "promises" | "aix" | "scenes" | "fc" | "calendar" | "search";
type TurnView = LineWatchPayload["turns"][number];
type SceneView = NonNullable<LineWatchPayload["daily"]>["scenes"][number];

// 判定の札（サーバーの line-watch-judge.ts と同じ5つ。画面はサーバー専用の物を import しないので名前だけここに置く）
const VERDICT_VIEW: Record<string, { label: string; cls: string }> = {
  same: { label: "そのまま", cls: "bg-emerald-100 text-emerald-700" },
  same_meaning: { label: "同じ事", cls: "bg-emerald-50 text-emerald-700" },
  partial: { label: "一部違う", cls: "bg-amber-100 text-amber-800" },
  different: { label: "別の事", cls: "bg-red-100 text-red-700" },
  na: { label: "比べられない", cls: "bg-slate-100 text-slate-500" },
};
const VERDICT_KEYS = ["same", "same_meaning", "partial", "different", "na"] as const;
const pct = (r: number | null | undefined) => (r == null ? "—" : `${Math.round(r * 100)}%`);
function sceneName(key: string): string {
  if (key.startsWith("AIX:")) return `AIX ${key.slice(4)}`;
  if (key.startsWith("返信:意図:")) return `返信（意図: ${key.slice(6)}）`;
  if (key.startsWith("返信:")) return `返信 ${key.slice(3)}`;
  return key;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function mins(n: number): string {
  if (n < 60) return `${n}分`;
  const h = Math.floor(n / 60);
  return `${h}時間${n % 60 ? `${n % 60}分` : ""}`;
}
const convHref = (id: string | null | undefined) => (id ? `/?conv=${encodeURIComponent(id)}` : undefined);

const COMPARE_JA: Record<string, { label: string; cls: string }> = {
  same: { label: "そのまま", cls: "bg-emerald-100 text-emerald-700" },
  edited: { label: "手直し", cls: "bg-amber-100 text-amber-800" },
  no_draft: { label: "下書きなし（手打ち）", cls: "bg-slate-100 text-slate-600" },
  sentinel: { label: "AIX の番", cls: "bg-sky-100 text-sky-700" },
  aix_only: { label: "AIX を送った", cls: "bg-sky-100 text-sky-700" },
  no_staff: { label: "まだ返していない", cls: "bg-red-100 text-red-700" },
};
const SEARCH_JA: Record<string, string> = { idle: "検索が要るのに動いていない", empty: "検索したが送れる物件0", ready: "送れる資料あり", short: "初回なのに通す物件が足りない" };

function Card({ title, count, alert, open, onToggle, children }: { title: string; count: number; alert?: boolean; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="mb-3 rounded-xl border border-[#e9edef] bg-white">
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <span className="text-[14px] font-bold text-slate-800">{title}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${alert && count > 0 ? "bg-red-100 text-red-700" : "bg-[#f0f2f5] text-[#54656f]"}`}>{count}</span>
        <span className="ml-auto text-slate-400">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="border-t border-[#f0f2f5] px-3 py-2">{children}</div>}
    </div>
  );
}
function Name({ id, name }: { id: string | null | undefined; name: string | null | undefined }) {
  const href = convHref(id);
  const label = name || "（名前なし）";
  return href ? <a href={href} className="font-bold text-[#1565C0]">{label}</a> : <span className="font-bold text-slate-700">{label}</span>;
}
const Empty = ({ text }: { text: string }) => <div className="py-4 text-center text-[12px] text-slate-400">{text}</div>;

export default function WatchPage() {
  const [data, setData] = useState<LineWatchPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [showTest, setShowTest] = useState(false);
  const [turnDays, setTurnDays] = useState(1);
  const [live, setLive] = useState(false);
  const [open, setOpen] = useState<Record<Section, boolean>>({ daily: true, waiting: true, turns: true, promises: false, aix: false, scenes: false, fc: false, calendar: false, search: false });
  const toggle = (s: Section) => setOpen((o) => ({ ...o, [s]: !o[s] }));
  // ✋を押した番（正しい判定を選ぶ行を開く）
  const [picking, setPicking] = useState<number | null>(null);
  const [saving, setSaving] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const qs = new URLSearchParams();
      if (showTest) qs.set("test", "1");
      if (turnDays > 1) qs.set("days", String(turnDays));
      if (live) qs.set("live", "1");
      const qsText = qs.toString();
      const res = await fetch(`/api/line-watch${qsText ? `?${qsText}` : ""}`, {
        cache: "no-store", headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` },
      });
      const j = await res.json().catch(() => ({ ok: false, error: `読めない（${res.status}）` }));
      if (!res.ok || !j.ok) throw new Error(j.error ?? `読めない（${res.status}）`);
      setData(j as LineWatchPayload);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, [showTest, turnDays, live]);

  // 👍／✋（物差しの校正）。書くのは line_watch_turns の verdict_review* だけ
  const review = useCallback(async (t: TurnView, value: "agree" | "disagree" | null, verdict?: string) => {
    if (!t.id) return;
    setSaving(t.id);
    try {
      const res = await fetch("/api/line-watch", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` },
        body: JSON.stringify({ turnId: t.id, review: value, verdict: verdict ?? null, rule: t.verdict }),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !j.ok) throw new Error(j.error ?? `保存できない（${res.status}）`);
      setData((d) => d && { ...d, turns: d.turns.map((x) => (x.id === t.id ? { ...x, review: value, reviewVerdict: value === "disagree" ? verdict ?? null : null } : x)) });
      setPicking(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setSaving(null);
  }, []);

  useEffect(() => { void load(); }, [load]);
  // 1分ごとに読み直す（画面を開いている間だけ）
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const d = data;
  const errKeys = d ? Object.keys(d.errors) : [];
  // 場面ごとの一致率・最終チェック: 「今の数で計算」を押した時は今の控えから、普段は毎晩のまとめ（20:50）の結果
  const scenes: SceneView[] = (live ? d?.liveStats?.scenes : d?.daily?.scenes) ?? [];
  const fc = (live ? d?.liveStats?.fc : d?.daily?.fc) ?? null;
  const c7 = d?.daily?.c7 ?? null;

  return (
    <main className="flex h-[100svh] flex-col bg-[#f7f9fa]" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="flex items-center gap-2 border-b border-[#e9edef] bg-white px-4 py-3">
        <h1 className="text-base font-bold text-slate-800">👁 LINE の見張り</h1>
        <span className="text-[11px] text-slate-400">読むだけ・2段目</span>
        <select value={turnDays} onChange={(e) => setTurnDays(Number(e.target.value))} className="ml-auto rounded-lg bg-[#f0f2f5] px-1.5 py-1 text-[11px] font-bold text-[#54656f]" aria-label="AI の案と実際の日数">
          <option value={1}>24時間</option><option value={3}>3日</option><option value={7}>7日</option>
        </select>
        <button onClick={() => setShowTest((v) => !v)} className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${showTest ? "bg-slate-700 text-white" : "bg-[#f0f2f5] text-[#54656f]"}`}>YUMA {showTest ? "表示" : "なし"}</button>
        <button onClick={() => void load()} className="rounded-lg bg-[#f0f2f5] px-2.5 py-1 text-[12px] font-bold text-[#54656f]">{loading ? "…" : "更新"}</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 pb-28">
        {err && <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{err}</div>}
        {!d && !err && <Empty text="読み込み中…" />}
        {d && (
          <>
            {/* 控えの様子（トリガーが動いているか。静かに壊れていないかをここで見る） */}
            <div className={`mb-3 rounded-xl border px-3 py-2 text-[12px] ${!d.capture.tableReady || d.capture.enabled === false ? "border-amber-300 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
              <div className="font-bold text-slate-700">
                {!d.capture.tableReady ? "控えの表がまだ無い（本番に流す前）" : d.capture.enabled === false ? `控えは止めている${d.capture.note ? `（${d.capture.note}）` : ""}` : "AI の案を番ごとに控えている"}
              </div>
              <div className="text-slate-600">
                直近24時間の控え {d.capture.turns24h}番{d.capture.lastTurnAt ? `・最後 ${fmt(d.capture.lastTurnAt)}` : ""} ・ 待ち {d.summary.waiting}人（60分超 {d.summary.late}）{d.summary.waitingStale ? `・3日より前から止まっている ${d.summary.waitingStale}人` : ""}{d.summary.waitingOutOfScope ? `・申込以降 ${d.summary.waitingOutOfScope}人は数えない` : ""} ・ {fmt(d.generatedAt)} 時点
              </div>
              {errKeys.length > 0 && <div className="mt-1 text-[11px] text-red-700">読めなかった欄: {errKeys.map((k) => `${k}（${d.errors[k]}）`).join("・")}</div>}
            </div>

            <Card title="📋 今日のまとめ（知らせる事）" count={d.daily?.alerts.length ?? 0} alert open={open.daily} onToggle={() => toggle("daily")}>
              {!d.daily && <Empty text="毎晩のまとめ（20:50）がまだありません" />}
              {d.daily && (
                <>
                  <div className="pb-1 text-[11px] text-slate-500">{d.daily.date ?? ""} のまとめ（{fmt(d.daily.startedAt)}）{d.daily.ok === false ? " ・ 読めなかった欄あり" : ""}</div>
                  {d.daily.alerts.length === 0 && <Empty text="知らせる事はありません" />}
                  {d.daily.alerts.map((a, i) => <div key={i} className="border-b border-[#f0f2f5] py-1.5 text-[12px] text-slate-700 last:border-b-0">・{a}</div>)}
                </>
              )}
              <div className="pt-1 text-[10px] text-slate-400">LLM なしで数えた物。LINE には送らない（売上番長グループは今まで通り AIX要対応だけ）</div>
            </Card>

            <Card title="⏳ 今待っているお客様" count={d.waiting.length} alert={d.summary.late > 0} open={open.waiting} onToggle={() => toggle("waiting")}>
              {d.waiting.length === 0 && <Empty text="待っているお客様はいません" />}
              {d.waiting.map((w) => (
                <div key={w.id} className="border-b border-[#f0f2f5] py-2 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                    <Name id={w.id} name={w.name} />
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${w.late ? "bg-red-600 text-white" : "bg-[#f0f2f5] text-[#54656f]"}`}>{mins(w.businessMin)}</span>
                    <span className="rounded bg-[#f0f2f5] px-1.5 py-0.5 text-[10px] text-[#54656f]">{w.scene}</span>
                    {w.auto && <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">自動</span>}
                    {w.isTest && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600">テスト</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">来た {fmt(w.turnAt)}{w.lastAt !== w.turnAt ? `〜${fmt(w.lastAt)}` : ""} ・ 案: {w.brain}{w.draftReady ? " ・ 下書きあり" : w.sentinel ? ` ・ ${w.sentinel}` : " ・ 下書きなし"}</div>
                  {w.draftHead && <div className="mt-0.5 line-clamp-2 text-[12px] text-slate-700">{w.draftHead}</div>}
                  {w.finalCheck && <div className={`mt-0.5 text-[11px] ${w.blocks ? "text-red-700" : "text-slate-500"}`}>最終チェック: {w.finalCheck}</div>}
                </div>
              ))}
              <div className="pt-1 text-[10px] text-slate-400">経過は営業時間（10〜19時）で数える。60分超を赤</div>
            </Card>

            <Card title={`🔁 AI の案と実際（${turnDays === 1 ? "24時間" : `${turnDays}日`}）`} count={d.turns.length} alert={d.turns.some((t) => t.factDiff)} open={open.turns} onToggle={() => toggle("turns")}>
              {!d.capture.tableReady && <Empty text="控えの表を本番に流した後から出ます" />}
              {d.capture.tableReady && d.turns.length === 0 && <Empty text="この期間の控えはありません" />}
              {d.turns.map((t) => {
                const c = COMPARE_JA[t.compare] ?? { label: t.compare, cls: "bg-slate-100 text-slate-600" };
                const v = t.verdict ? VERDICT_VIEW[t.verdict] : null;
                const canReview = !!t.id && d.reviewReady && !!t.verdict;
                return (
                  <div key={`${t.conversationId}-${t.turnAt}`} className="border-b border-[#f0f2f5] py-2 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                      <Name id={t.conversationId} name={t.name} />
                      {v && <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${v.cls}`}>{v.label}{t.verdictStored ? "" : "（仮）"}</span>}
                      {t.factDiff && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">事実違い</span>}
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${c.cls}`}>{c.label}{t.sim != null && t.compare === "edited" ? ` ${Math.round(t.sim * 100)}%` : ""}</span>
                      <span className="rounded bg-[#f0f2f5] px-1.5 py-0.5 text-[10px] text-[#54656f]">{t.scene}</span>
                      {t.draftVersions > 1 && <span className="text-[10px] text-slate-400">作り直し {t.draftVersions}回</span>}
                      {t.draftBeforeStaff === false && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">下書きが送信より後</span>}
                      {canReview && (
                        <span className="ml-auto flex items-center gap-1">
                          <button disabled={saving === t.id} onClick={() => void review(t, t.review === "agree" ? null : "agree")} className={`rounded px-1.5 py-0.5 text-[12px] ${t.review === "agree" ? "bg-emerald-600 text-white" : "bg-[#f0f2f5]"}`} title="判定が正しい">👍</button>
                          <button disabled={saving === t.id} onClick={() => (t.review === "disagree" ? void review(t, null) : setPicking(picking === t.id ? null : t.id))} className={`rounded px-1.5 py-0.5 text-[12px] ${t.review === "disagree" ? "bg-red-600 text-white" : "bg-[#f0f2f5]"}`} title="判定が違う">✋</button>
                        </span>
                      )}
                    </div>
                    {t.verdictText && <div className="mt-0.5 text-[11px] text-slate-600">判定: {t.verdictText}{t.uncertain ? " ・ 割り切れない" : ""}{t.review === "disagree" && t.reviewVerdict ? ` ・ ✋ 本当は「${VERDICT_VIEW[t.reviewVerdict]?.label ?? t.reviewVerdict}」` : ""}</div>}
                    {picking === t.id && (
                      <div className="mt-1 flex flex-wrap items-center gap-1 rounded-lg bg-red-50 px-2 py-1.5 text-[11px]">
                        <span className="text-red-700">本当は:</span>
                        {VERDICT_KEYS.filter((k) => k !== t.verdict).map((k) => (
                          <button key={k} disabled={saving === t.id} onClick={() => void review(t, "disagree", k)} className={`rounded px-1.5 py-0.5 font-bold ${VERDICT_VIEW[k].cls}`}>{VERDICT_VIEW[k].label}</button>
                        ))}
                      </div>
                    )}
                    <div className="mt-0.5 text-[11px] text-slate-500">{fmt(t.turnAt)} ・ 案: {t.brain}{t.kinds.length ? ` ・ 違い: ${t.kinds.join("・")}` : ""}</div>
                    {t.draftHead && <div className="mt-0.5 text-[12px] text-slate-700"><span className="text-slate-400">案 </span>{t.draftHead}</div>}
                    {t.staffHead && <div className="mt-0.5 text-[12px] text-slate-700"><span className="text-slate-400">実際 </span>{t.staffHead}</div>}
                    {t.finalCheck && <div className="mt-0.5 text-[11px] text-slate-500">最終チェック: {t.finalCheck}</div>}
                  </div>
                );
              })}
              <div className="pt-1 text-[10px] text-slate-400">判定は毎晩 20:40 に決まった規則で付く（今日の番は同じ規則の仮）。「実際」は返事のまとまり（最初の返事から10分以内に続いた文・30分まで）。判定がおかしければ ✋ で本当の判定を選ぶ＝物差しを直す材料{!d.reviewReady ? "（👍✋は2段目の SQL を流した後から）" : ""}</div>
            </Card>

            <Card title="🤝 約束の未対応" count={d.promises.filter((p) => p.customerActive).length} alert open={open.promises} onToggle={() => toggle("promises")}>
              {d.promises.length === 0 && <Empty text="果たしていない約束はありません" />}
              {d.promises.map((p) => (
                <div key={`${p.conversationId}-${p.kind}`} className={`border-b border-[#f0f2f5] py-2 last:border-b-0 ${p.customerActive ? "" : "opacity-50"}`}>
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                    <Name id={p.conversationId} name={p.name} />
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">{p.kindJa}</span>
                    <span className={`text-[11px] ${p.hours >= 48 ? "font-bold text-red-700" : "text-slate-500"}`}>{p.hours}時間</span>
                    {!p.customerActive && <span className="text-[10px] text-slate-400">お客様が止まっている</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">{fmt(p.sentAt)}{p.evidence ? ` ・ 「${p.evidence}」` : ""}</div>
                </div>
              ))}
            </Card>

            <Card title="⚡ AIX要対応" count={d.aixItems.length} open={open.aix} onToggle={() => toggle("aix")}>
              {d.aixItems.length === 0 && <Empty text="AIX要対応はありません" />}
              {d.aixItems.map((a) => (
                <div key={`${a.conversationId}-${a.createdAt}`} className="flex flex-wrap items-center gap-1.5 border-b border-[#f0f2f5] py-2 text-[13px] last:border-b-0">
                  <Name id={a.conversationId} name={a.name} />
                  <span>→</span>
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-bold text-sky-700">{a.label}{a.checkPattern ? `（${a.checkPattern}）` : ""}</span>
                  <span className="ml-auto text-[11px] text-slate-400">{fmt(a.createdAt)}</span>
                </div>
              ))}
              <div className="pt-1 text-[10px] text-slate-400">売上番長グループの一覧と同じ物（グループへの通知は増やさない）</div>
            </Card>

            <Card title="📊 場面ごとの一致率（28日）" count={scenes.filter((s) => s.unlock).length} open={open.scenes} onToggle={() => toggle("scenes")}>
              <div className="flex items-center gap-2 pb-1 text-[11px] text-slate-500">
                <span>{live ? `今の控えから計算（${d.liveStats?.turns ?? 0}番）` : d.daily ? `毎晩のまとめ（${fmt(d.daily.startedAt)}）` : "毎晩のまとめがまだ無い"}</span>
                <button onClick={() => setLive((v) => !v)} className="ml-auto rounded bg-[#f0f2f5] px-2 py-0.5 font-bold text-[#54656f]">{live ? "まとめに戻す" : "今の数で計算"}</button>
              </div>
              {scenes.length === 0 && <Empty text="判定の付いた番がまだありません（控えが溜まり、毎晩の判定が付いてから）" />}
              {scenes.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead><tr className="text-left text-slate-400"><th className="py-1 pr-2 font-normal">場面</th><th className="pr-2 font-normal">番</th><th className="pr-2 font-normal">一致</th><th className="pr-2 font-normal">文の一致</th><th className="pr-2 font-normal">事実違い</th><th className="pr-2 font-normal">別(14日)</th><th className="font-normal">状態</th></tr></thead>
                    <tbody>
                      {scenes.map((s) => (
                        <tr key={s.scene} className="border-t border-[#f0f2f5] align-top">
                          <td className="py-1 pr-2 text-slate-700">{sceneName(s.scene)}</td>
                          <td className="pr-2">{s.cur.n}</td>
                          <td className={`pr-2 font-bold ${(s.cur.rate ?? 0) >= 0.9 ? "text-emerald-700" : "text-slate-700"}`}>{pct(s.cur.rate)}</td>
                          <td className="pr-2">{s.cur.textN ? `${s.cur.textAgree}/${s.cur.textN}` : "—"}</td>
                          <td className={`pr-2 ${s.cur.factDiff ? "font-bold text-red-700" : ""}`}>{s.cur.factDiff}</td>
                          <td className="pr-2">{s.last14Different}</td>
                          <td>{s.unlock ? <span className="rounded bg-emerald-600 px-1 text-white">解禁の線</span> : s.stop ? <span className="rounded bg-red-600 px-1 text-white">停止の線</span> : <span className="text-slate-500">影{s.remaining.length ? `（${s.remaining.join("・")}）` : ""}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="pt-1 text-[10px] text-slate-400">一致＝そのまま＋同じ事。解禁の線＝28日で30番以上・一致90%以上・事実違い0・別の事(14日)0を1週前の28日も満たす。表示するだけ（自動送信を開けるのは3段目・竹内さんが決める）</div>
            </Card>

            <Card title="🧪 最終チェックの段ごとの指摘（28日）" count={fc?.withIssues ?? 0} open={open.fc} onToggle={() => toggle("fc")}>
              {!fc || fc.turns === 0 ? <Empty text="最終チェックの記録がある番がまだありません" /> : (
                <>
                  <div className="pb-1 text-[11px] text-slate-600">{fc.turns}番 ・ 指摘あり {fc.withIssues} ・ 直した {fc.revisedTurns} ・ 最後に残った指摘: {Object.entries(fc.byStage).map(([k, n]) => `${k} ${n}`).join("・") || "なし"}</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead><tr className="text-left text-slate-400"><th className="py-1 pr-2 font-normal">場面</th><th className="pr-2 font-normal">段</th><th className="pr-2 font-normal">code</th><th className="pr-2 font-normal">修正前</th><th className="pr-2 font-normal">最後</th><th className="font-normal">直した</th></tr></thead>
                      <tbody>
                        {fc.rows.map((r, i) => (
                          <tr key={i} className="border-t border-[#f0f2f5]">
                            <td className="py-1 pr-2 text-slate-700">{sceneName(r.scene)}</td><td className="pr-2">{r.stage}</td><td className="pr-2 font-mono">{r.code}</td>
                            <td className="pr-2">{r.pre}</td><td className={`pr-2 ${r.blocks ? "font-bold text-red-700" : ""}`}>{r.final}{r.blocks ? `（block ${r.blocks}）` : ""}</td><td>{r.revised}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <div className="pt-1 text-[10px] text-slate-400">修正前の指摘は記録に段が無いので、同じ code が最後にあればその段・_DET は決定論・他は「不明」。省けるかの線は「LLM の段の指摘で直しで本文が変わった番が0」（設計 §5・今は見るだけ）</div>
            </Card>

            <Card title="📅 カレンダー" count={d.calendar.length + (c7?.findings.length ?? 0)} alert open={open.calendar} onToggle={() => toggle("calendar")}>
              {d.calendar.length === 0 && <Empty text="こちらの予定の食い違いはありません" />}
              {d.calendar.map((c, i) => (
                <div key={`${c.code}-${i}`} className="border-b border-[#f0f2f5] py-2 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">{c.code}</span>
                    {c.conversationId ? <Name id={c.conversationId} name={c.name} /> : <span className="text-slate-500">会話なし</span>}
                    <span className="text-[11px] text-slate-500">{c.day ?? ""}</span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-slate-700">{c.codeJa}</div>
                  <div className="text-[11px] text-slate-500">{c.detail}{c.eventIds.length ? ` ・ 予定 #${c.eventIds.join("・#")}` : ""}</div>
                </div>
              ))}
              {d.deletions.length > 0 && (
                <div className="mt-2 text-[11px] text-slate-500">取りやめで消した予定（控え・30日）: {d.deletions.map((x) => `#${x.eventId} ${fmt(x.deletedAt)}`).join("、")}</div>
              )}
              <div className="mt-2 border-t border-[#f0f2f5] pt-2 text-[12px] font-bold text-slate-700">申込ツールのカレンダーとの突き合わせ（C7・毎晩）</div>
              {!c7 && <div className="py-1 text-[11px] text-slate-400">毎晩のまとめがまだありません</div>}
              {c7 && !c7.measured && <div className="py-1 text-[11px] text-amber-700">測れない: {c7.reason ?? "理由不明"}</div>}
              {c7 && c7.measured && c7.findings.length === 0 && <div className="py-1 text-[11px] text-slate-400">食い違いはありません</div>}
              {c7?.findings.map((f, i) => (
                <div key={`c7-${i}`} className="border-b border-[#f0f2f5] py-1.5 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">{String(f.code)}</span>
                    {f.conversation_id ? <Name id={String(f.conversation_id)} name={(f.name as string | null) ?? null} /> : <span className="text-slate-600">{String(f.name ?? "会話なし")}</span>}
                    <span className="text-[11px] text-slate-500">{String(f.day ?? "")}</span>
                  </div>
                  <div className="text-[11px] text-slate-500">{String(f.detail ?? "")}</div>
                </div>
              ))}
              <div className="pt-1 text-[10px] text-slate-400">C1〜C6 はこちらの予定（今の数）。C7 は申込ツールの daily_tasks を読むだけ（申込ツールのコードは触らない）</div>
            </Card>

            <Card title="🔍 物件検索" count={d.search.length} open={open.search} onToggle={() => toggle("search")}>
              {d.search.length === 0 && <Empty text="気になるお客様はいません" />}
              {d.search.map((s, i) => (
                <div key={`${s.kind}-${i}`} className="border-b border-[#f0f2f5] py-2 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${s.kind === "ready" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>{SEARCH_JA[s.kind]}</span>
                    {s.conversationId ? <Name id={s.conversationId} name={s.name} /> : <span className="text-slate-500">会話なし</span>}
                    <span className="ml-auto text-[11px] text-slate-400">{fmt(s.at)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">{s.detail}</div>
                </div>
              ))}
            </Card>
          </>
        )}
      </div>
      <BottomNav />
    </main>
  );
}
