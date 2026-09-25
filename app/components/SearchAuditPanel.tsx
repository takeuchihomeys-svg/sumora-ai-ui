"use client";
// app/components/SearchAuditPanel.tsx
// AIXツールの「🔍 検索の点検」（2026-09-25 竹内「ブレインモードで物件自動検索や一括検索した際に、検索がちゃんとされていなかったら
//   原因を見つけられるようにする。…そうすればずっと拡張ツール側も成長していく。問題や読み取れていない部分が分かる」）
// 原因ごと: 件数（7日／30日）・例・DeepSeek の直し方の案・状態（未対応／直した＋版／無視）・直した版以降に同じ原因が出たら「再発」。
// 回ごと: 直近の検索の1回ずつ（見出し「この回の検索: 駅 3/4・東三国が入っていない」）。
// 決まり（札・見出し）は app/lib/search-audit-check.ts（純関数）。ここは /api/search-audits を読んで描くだけ（サーバー専用の物は import しない）
import { useCallback, useEffect, useState } from "react";

type Diagnosis = { cause_ja?: string; fix_ja?: string; where?: { file?: string; function?: string }; is_genuine_zero?: boolean | null; confidence?: number; reused_from?: string; failed?: boolean };
type Cause = {
  cause_key: string; title: string | null; site: string | null; count_7d: number; count_total: number; first_seen: string | null; last_seen: string | null;
  example_run_ids: string[] | null; fix_hint: string | null; status: "open" | "fixed" | "ignored"; fixed_in_version: string | null; fixed_at: string | null; note: string | null;
  count_window: number; bad_window: number; count_30d: number; recurred: boolean; latest_diagnosis: Diagnosis | null; latest_run_id: string | null;
};
type Check = { code: string; severity: "ok" | "warn" | "bad"; cause_key: string; title: string; detail: string };
type Run = {
  run_id: string; created_at: string; status: string; site: string | null; trigger: string | null; mode: string | null; is_wide: boolean | null;
  severity: "ok" | "warn" | "bad" | null; cause_key: string | null; ai_status: string | null; ext_version: string | null; headline: string | null;
  checks: Check[]; ai_diagnosis: Diagnosis | null; result: Record<string, unknown> | null;
};
type Weekly = { at: string | null; result: { summary?: { summary_ja?: string; priorities?: Array<{ cause_key: string; why_ja: string; fix_ja: string }> } | null; runs?: number } | null };

const SITE_JA: Record<string, string> = { realpro: "リアプロ", itandi: "itandi", reins: "レインズ" };
const TRIGGER_JA: Record<string, string> = { bulk_queue: "一括（拡張）", web_brain: "一括（AIXツール）", bulk_manual: "一括（手動）", single: "個別", scrape_compare: "比較" };
const SEV_STYLE: Record<string, string> = { bad: "bg-red-100 text-red-700", warn: "bg-amber-100 text-amber-800", ok: "bg-emerald-100 text-emerald-700" };

function fmt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function SearchAuditPanel({ onClose, extVersion }: { onClose: () => void; extVersion?: string }) {
  const [view, setView] = useState<"causes" | "runs">("causes");
  const [days, setDays] = useState<7 | 30>(7);
  const [causes, setCauses] = useState<Cause[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [runsWindow, setRunsWindow] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [ver, setVer] = useState<string>(extVersion ?? "2.5.25");
  const [filter, setFilter] = useState<"open" | "all">("open");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      if (view === "causes") {
        const [c, w] = await Promise.all([
          fetch(`/api/search-audits?view=causes&days=${days}`, { cache: "no-store" }).then((r) => r.json()),
          fetch(`/api/search-audits?view=weekly`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        ]);
        if (!c.ok) throw new Error(c.error ?? "読み込めない");
        setCauses(c.causes ?? []); setRunsWindow(c.runs_window ?? 0); setWeekly(w && w.ok ? w : null);
      } else {
        const r = await fetch(`/api/search-audits?view=runs&days=${days}&limit=150`, { cache: "no-store" }).then((x) => x.json());
        if (!r.ok) throw new Error(r.error ?? "読み込めない");
        setRuns(r.runs ?? []);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, [view, days]);

  useEffect(() => { void load(); }, [load]);

  async function setStatus(c: Cause, status: "open" | "fixed" | "ignored") {
    const res = await fetch("/api/search-audits", {
      method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` },
      body: JSON.stringify({ cause_key: c.cause_key, status, fixed_in_version: status === "fixed" ? ver : null }),
    }).then((r) => r.json()).catch(() => ({ ok: false, error: "通信できない" }));
    if (!res.ok) { setErr(res.error ?? "変えられない"); return; }
    void load();
  }

  // 未対応だけ＝未対応か再発した物（直した・無視は「全部」で見る）
  const shown = filter === "all" ? causes : causes.filter((c) => c.status === "open" || c.recurred);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="flex items-center gap-2 border-b border-[#e9edef] px-4 py-3">
        <button onClick={onClose} className="text-slate-500 text-lg leading-none" aria-label="閉じる">←</button>
        <h2 className="text-base font-bold text-slate-800">🔍 検索の点検</h2>
        <span className="text-[11px] text-slate-400">ブレインモードの検索だけ</span>
        <button onClick={() => void load()} className="ml-auto rounded-lg bg-[#f0f2f5] px-2.5 py-1 text-[12px] font-bold text-[#54656f]">{loading ? "…" : "更新"}</button>
      </div>

      <div className="flex gap-2 border-b border-[#e9edef] px-4 py-2 text-[12px]">
        {(["causes", "runs"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} className={`rounded-full px-3 py-1 font-bold ${view === v ? "bg-[#1565C0] text-white" : "bg-[#f0f2f5] text-[#54656f]"}`}>
            {v === "causes" ? "原因ごと" : "回ごと"}
          </button>
        ))}
        <span className="mx-1 w-px bg-[#e9edef]" />
        {([7, 30] as const).map((d) => (
          <button key={d} onClick={() => setDays(d)} className={`rounded-full px-3 py-1 font-bold ${days === d ? "bg-slate-700 text-white" : "bg-[#f0f2f5] text-[#54656f]"}`}>{d}日</button>
        ))}
        {view === "causes" && (
          <button onClick={() => setFilter(filter === "open" ? "all" : "open")} className="ml-auto rounded-full bg-[#f0f2f5] px-3 py-1 font-bold text-[#54656f]">
            {filter === "open" ? "未対応だけ" : "全部"}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {err && <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{err}</div>}

        {view === "causes" && (
          <>
            {weekly?.result?.summary?.summary_ja && (
              <div className="mb-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2">
                <div className="text-[11px] font-bold text-sky-800">今週のまとめ（{fmt(weekly.at)}・DeepSeek）</div>
                <div className="mt-1 text-[12px] leading-relaxed text-slate-700">{weekly.result.summary.summary_ja}</div>
                {(weekly.result.summary.priorities ?? []).slice(0, 5).map((p, i) => (
                  <div key={i} className="mt-1 text-[11px] text-slate-600">{i + 1}. <span className="font-mono">{p.cause_key}</span> — {p.why_ja}{p.fix_ja ? ` → ${p.fix_ja}` : ""}</div>
                ))}
              </div>
            )}
            <div className="mb-2 text-[11px] text-slate-500">直近{days}日の検索 {runsWindow}回 ・ 原因 {shown.length}件{loading ? "（読み込み中）" : ""}</div>
            {!loading && shown.length === 0 && <div className="py-10 text-center text-[13px] text-slate-400">点検で見つかった原因はありません</div>}
            {shown.map((c) => {
              const open = openKey === c.cause_key;
              const d = c.latest_diagnosis;
              return (
                <div key={c.cause_key} className="mb-2 rounded-xl border border-[#e9edef] bg-white">
                  <button onClick={() => setOpenKey(open ? null : c.cause_key)} className="flex w-full items-start gap-2 px-3 py-2 text-left">
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {c.recurred && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">再発</span>}
                        {c.status === "fixed" && !c.recurred && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">直した {c.fixed_in_version ?? ""}</span>}
                        {c.status === "ignored" && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">無視</span>}
                        {c.bad_window > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">重い {c.bad_window}</span>}
                        <span className="text-[13px] font-bold text-slate-800">{c.title ?? c.cause_key}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">7日 {days === 7 ? c.count_window : c.count_7d}回 ・ 30日 {c.count_30d}回 ・ 最後 {fmt(c.last_seen)}</div>
                      {d?.cause_ja && !open && <div className="mt-0.5 line-clamp-1 text-[11px] text-slate-600">💡 {d.cause_ja}</div>}
                    </div>
                    <span className="text-slate-400">{open ? "▴" : "▾"}</span>
                  </button>
                  {open && (
                    <div className="border-t border-[#f0f2f5] px-3 py-2 text-[12px] text-slate-700">
                      <div className="font-mono text-[10px] text-slate-400 break-all">{c.cause_key}</div>
                      {d && !d.failed ? (
                        <div className="mt-1.5 rounded-lg bg-[#f7f9fa] px-2 py-1.5">
                          <div className="text-[11px] font-bold text-slate-500">DeepSeek の見立て{d.reused_from ? "（同じ原因の見立てを使い回し）" : ""}{typeof d.confidence === "number" ? `・確からしさ ${Math.round(d.confidence * 100)}%` : ""}</div>
                          <div className="mt-0.5">原因: {d.cause_ja}</div>
                          {d.fix_ja && <div className="mt-0.5">直し方の案: {d.fix_ja}</div>}
                          {d.where?.file && <div className="mt-0.5 text-[11px] text-slate-500">場所: {d.where.file}{d.where.function ? ` ・ ${d.where.function}` : ""}</div>}
                          {d.is_genuine_zero === true && <div className="mt-0.5 text-[11px] text-emerald-700">本当に0件だった見込み</div>}
                        </div>
                      ) : c.fix_hint ? (
                        <div className="mt-1.5 whitespace-pre-wrap rounded-lg bg-[#f7f9fa] px-2 py-1.5">{c.fix_hint}</div>
                      ) : (
                        <div className="mt-1.5 text-[11px] text-slate-400">見立てはまだありません（重い回・0件の回だけ DeepSeek に聞きます）</div>
                      )}
                      <div className="mt-1.5 text-[11px] text-slate-500">例の回: {(c.example_run_ids ?? []).slice(0, 3).join("、") || "なし"}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <button onClick={() => void setStatus(c, "open")} className={`rounded-lg px-2.5 py-1 text-[12px] font-bold ${c.status === "open" ? "bg-slate-700 text-white" : "bg-[#f0f2f5] text-[#54656f]"}`}>未対応</button>
                        <input value={ver} onChange={(e) => setVer(e.target.value)} className="w-16 rounded-lg border border-[#e9edef] px-1.5 py-1 text-[12px]" aria-label="直した版" />
                        <button onClick={() => void setStatus(c, "fixed")} className={`rounded-lg px-2.5 py-1 text-[12px] font-bold ${c.status === "fixed" ? "bg-emerald-600 text-white" : "bg-[#f0f2f5] text-[#54656f]"}`}>直した</button>
                        <button onClick={() => void setStatus(c, "ignored")} className={`rounded-lg px-2.5 py-1 text-[12px] font-bold ${c.status === "ignored" ? "bg-slate-500 text-white" : "bg-[#f0f2f5] text-[#54656f]"}`}>無視</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {view === "runs" && (
          <>
            {!loading && runs.length === 0 && <div className="py-10 text-center text-[13px] text-slate-400">直近{days}日にブレインモードの検索はありません</div>}
            {runs.map((r) => {
              const open = openKey === r.run_id;
              return (
                <div key={r.run_id} className="mb-2 rounded-xl border border-[#e9edef] bg-white">
                  <button onClick={() => setOpenKey(open ? null : r.run_id)} className="flex w-full items-start gap-2 px-3 py-2 text-left">
                    <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${SEV_STYLE[r.severity ?? ""] ?? "bg-slate-100 text-slate-500"}`}>{r.status === "started" ? "途中" : r.severity ?? "?"}</span>
                    <div className="flex-1">
                      <div className="text-[12px] font-bold text-slate-800">{r.headline ?? (r.status === "started" ? "検索中（まだ終わっていない）" : "この回の検索")}</div>
                      <div className="text-[11px] text-slate-500">{fmt(r.created_at)} ・ {SITE_JA[r.site ?? ""] ?? r.site} ・ {TRIGGER_JA[r.trigger ?? ""] ?? r.trigger}{r.is_wide ? " ・ 広げて" : ""}{r.ext_version ? ` ・ v${r.ext_version}` : ""}</div>
                    </div>
                    <span className="text-slate-400">{open ? "▴" : "▾"}</span>
                  </button>
                  {open && (
                    <div className="border-t border-[#f0f2f5] px-3 py-2 text-[12px] text-slate-700">
                      {r.checks.length === 0 && <div className="text-[11px] text-slate-400">札なし</div>}
                      {r.checks.map((c, i) => (
                        <div key={i} className="mb-1">
                          <span className={`mr-1 rounded px-1 py-0.5 text-[10px] font-bold ${SEV_STYLE[c.severity]}`}>{c.code}</span>
                          {c.title}<span className="text-[11px] text-slate-500"> — {c.detail}</span>
                        </div>
                      ))}
                      {r.result && <div className="mt-1 text-[11px] text-slate-500">ページ {String(r.result.pages ?? "?")} ・ 読んだ行 {String(r.result.read_rows ?? "?")} ・ 送れる {String(r.result.sendable_rows ?? "?")} ・ 送った {String(r.result.sent_count ?? "?")}{r.result.count_text ? ` ・ 件数表示「${String(r.result.count_text)}」` : ""}</div>}
                      {r.ai_diagnosis?.cause_ja && <div className="mt-1 rounded-lg bg-[#f7f9fa] px-2 py-1">💡 {r.ai_diagnosis.cause_ja}{r.ai_diagnosis.fix_ja ? ` → ${r.ai_diagnosis.fix_ja}` : ""}</div>}
                      <div className="mt-1 font-mono text-[10px] text-slate-400">{r.run_id}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
