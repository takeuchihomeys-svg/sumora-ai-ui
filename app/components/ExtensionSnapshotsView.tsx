"use client";
// app/components/ExtensionSnapshotsView.tsx
// AIXツール「🔍 検索の点検」の「📷 拡張の画面」（2026-09-29 竹内「なぜ固まっているのか」
//   「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」）
// ・PC ごと: 拡張の版（今の版より古ければ赤＝再読み込みしていない）・モード・最後の心拍（3分より古ければ「応答なし」）・実行中の回・写真の許可
// ・「今の画面を撮る」→ 動いている PC が1分以内に撮って送る → 写真・ページの文字（件数・ページ・モーダル・帯）・ログの末尾を1枚で見せる
// ・止まった時（6分動きなし・待ちの時間切れ・1回の検索の上限）に拡張が自動で撮った物もここに並ぶ
// 読むのは /api/extension-snapshots（Bearer の内部認証・写真にお客様の名前が入るため）。サーバー専用の物は import しない
import { useCallback, useEffect, useRef, useState } from "react";

type Device = {
  install_id: string; device_label: string | null; ext_version: string | null; mode: string | null; batch_running: boolean;
  batch_command_id: string | null; last_progress_at: string | null; current_customer_id: string | null; current_site: string | null;
  waiting_for: string | null; can_capture: boolean; staff_mode: boolean; last_seen_at: string; stale: boolean; outdated: boolean; seen_ago_sec: number;
};
type TabShot = {
  site?: string; url?: string; title?: string; active?: boolean; visibility?: string | null; window_state?: string | null;
  activated_for_capture?: boolean; image_url?: string; image_error?: string | null; dom_error?: string | null;
  dom?: { count_text?: string | null; page_text?: string | null; alert_text?: string | null; modal_text?: string | null; band_text?: string | null; selected_count?: string | null; text_head?: string | null } | null;
};
type Snapshot = {
  id: number; created_at: string; trigger: string | null; install_id: string | null; device_label: string | null; ext_version: string | null; mode: string | null;
  batch_command_id: string | null; audit_run_id: string | null; band_text: string | null; can_capture: boolean | null; tabs: TabShot[] | null;
  stall: { why?: string | null; watch?: Record<string, unknown> | null } | null; log_tail: Array<{ t: number | null; l: string | null; m: string | null }> | null; error: string | null;
};

const TRIGGER_JA: Record<string, string> = {
  stall: "止まり（6分動きなし）", pass_deadline: "1回の検索の上限", waiter_timeout: "送信の終わりの待ち切れ", fill_timeout: "検索の完了の待ち切れ",
  request: "頼まれて撮った", run_end: "回の終わり",
};
const MODE_JA: Record<string, string> = { brain_aix: "🧠×AIX", brain_normal: "🧠×通常", brain_staff: "🧠×スタッフ", aix: "AIX", normal: "通常", staff: "スタッフ" };
const SITE_JA: Record<string, string> = { realpro: "リアプロ", realnetpro: "リアプロ", itandi: "itandi", reins: "レインズ" };

function fmt(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function ago(sec: number): string {
  if (sec < 90) return `${sec}秒前`;
  if (sec < 5400) return `${Math.round(sec / 60)}分前`;
  return `${Math.round(sec / 3600)}時間前`;
}
const authHeader = () => ({ Authorization: `Bearer ${process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? ""}` });

// ── 👁 見張り（2026-09-29・/api/screen-watch?view=live を20秒ごとに読む）─────────────────────────
// 今の回・判断の流れ（①決定論 ②Jev ③DeepSeek ④裁定）・異常の一覧（その後の実際）・今日の費用。サーバー専用の物は import しない
type WatchEvent = {
  id: number; created_at: string; run_id: string | null; property_customer_id: string | null; site: string | null; checkpoint: string;
  det_label: string | null; det_hard: boolean | null; jev_label: string | null; jev_prob: number | null; ds_label: string | null; ds_image: boolean | null; ds_note: string | null;
  arbiter: { right?: string; missing?: string[]; extra?: string[]; next?: string; reason_ja?: string; intent?: string; expect?: string } | null;
  final_label: string; action: string | null; action_reason: string | null; budget_state: string | null; cost_usd: number | null; outcome: string | null;
  material: { count?: number | null; count_text?: string | null; reason?: string | null; notice?: string | null } | null;
};
type WatchLive = {
  ok: boolean; error?: string; table_missing?: boolean; names?: Record<string, string>;
  config?: { enabled: boolean; dailyUsd: number; jev: string; image: boolean; autoTune: boolean; notifyGroup: boolean };
  runs?: Array<{ run_id: string; created_at: string; property_customer_id: string | null; site: string | null; trigger: string | null; is_wide: boolean | null; last_step: string | null; ext_version: string | null }>;
  events?: WatchEvent[];
  anomalies?: { by_label: Record<string, { n: number; hit: number; false_alarm: number; pending: number }>; recent: WatchEvent[] };
  last_shot?: Record<string, { id: number; created_at: string; image_url: string | null; trigger: string | null }>;
  cost?: { spent_usd: number | null; cap_usd: number; capped: boolean; counts: Record<string, number>; error: string | null };
};
const LABEL_JA: Record<string, string> = {
  normal: "問題なし", stuck: "止まり", login_expired: "ログイン切れ", modal_blocking: "モーダル", wrong_conditions: "条件が入り切っていない",
  zero_suspicious: "0件の疑い", site_error: "サイトのエラー", decision_drift: "決め方のズレ", unknown: "分からない",
};
const CP_JA: Record<string, string> = { filled: "C1 条件を入れた後", results: "C2 検索結果", done: "C3 回の終わり", stall: "C4 動きなし" };
const ACTION_JA: Record<string, string> = { none: "—", wait: "待つ", stop_site: "⛔ 止めた", flag: "⚠ 知らせ", suggest: "💡 提案" };
const OUTCOME_JA: Record<string, string> = { hit: "当たり", false_alarm: "外れ（誤警報）", miss: "見逃し", ok: "問題なし" };

function ScreenWatchLive() {
  const [d, setD] = useState<WatchLive | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/screen-watch?view=live", { cache: "no-store", headers: authHeader() }).then((x) => x.json()).catch(() => ({ ok: false, error: "通信できない" }));
    setD(r as WatchLive);
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 20_000); return () => clearInterval(t); }, [load]);
  async function reSearch(id: number) {
    setMsg("積んでいます…");
    const r = await fetch("/api/screen-watch", { method: "POST", headers: { "Content-Type": "application/json", ...authHeader() }, body: JSON.stringify({ action: "re_search_temp", event_id: id, requested_by: "aix-tool" }) })
      .then((x) => x.json()).catch(() => ({ ok: false, error: "通信できない" }));
    setMsg(r.ok ? `一時調整の再検索を積みました（${String(r.commandId ?? "").slice(0, 8)}）。ブレインの PC が拾います` : `積めない: ${r.error ?? "?"}`);
  }
  if (!d) return <div className="mb-3 text-[12px] text-slate-400">👁 見張りを読み込み中…</div>;
  if (!d.ok) return <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">👁 見張り: {d.error ?? "読み込めない"}</div>;
  const name = (id: string | null) => (id && d.names?.[id]) || (id ? id.slice(0, 8) : "?");
  const c = d.cost;
  return (
    <div className="mb-4 rounded-xl border border-[#d6e4f0] bg-[#f7fbff] p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold text-slate-800">👁 見張り</span>
        {d.config && !d.config.enabled && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">止めてある（SCREEN_WATCH=off）</span>}
        {d.config && <span className="text-[10px] text-slate-500">Jev: {d.config.jev === "shadow" ? "影（記録だけ）" : d.config.jev}・写真: {d.config.image ? "文字が無い時だけ" : "使わない"}</span>}
        {c && <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-bold ${c.capped ? "bg-red-600 text-white" : "bg-emerald-100 text-emerald-800"}`}>今日の費用 {c.spent_usd == null ? "?" : `$${c.spent_usd.toFixed(3)}`} / ${c.cap_usd}</span>}
      </div>
      {c?.capped && <div className="mb-1.5 rounded-lg bg-red-600 px-2 py-1 text-[11px] font-bold text-white">上限に達したので決定論だけで見張り中{c.error ? `（${c.error}）` : ""}</div>}
      {d.table_missing && <div className="mb-1.5 rounded-lg bg-amber-50 px-2 py-1 text-[11px] text-amber-900">見張りの表がまだありません（migrate-schema を流すと記録が始まります。流す前も決定論の「止める」は動きます）</div>}
      {msg && <div className="mb-1.5 rounded-lg bg-sky-50 px-2 py-1 text-[11px] text-sky-800">{msg}</div>}

      <div className="mb-1 text-[11px] font-bold text-slate-500">今の回</div>
      {(d.runs ?? []).length === 0 ? <div className="mb-2 text-[11px] text-slate-400">動いている回はありません</div> : (d.runs ?? []).map((r) => (
        <div key={r.run_id} className="mb-1 text-[11px] text-slate-700">▶ {name(r.property_customer_id)}さん・{SITE_JA[r.site ?? ""] ?? r.site}・{r.is_wide ? "広げて" : "ピンポイント"}・段: {r.last_step ?? "-"}・{fmt(r.created_at)} から</div>
      ))}
      {Object.entries(d.last_shot ?? {}).slice(0, 2).map(([k, s]) => s.image_url ? (
        <a key={k} href={s.image_url} target="_blank" rel="noreferrer" className="mr-2 inline-block"><img src={s.image_url} alt="最新の写真" className="h-20 rounded border border-[#e9edef]" /><div className="text-[9px] text-slate-400">{fmt(s.created_at)}</div></a>
      ) : null)}

      <div className="mb-1 mt-2 text-[11px] font-bold text-slate-500">異常（7日・その後の実際）</div>
      <div className="mb-1 flex flex-wrap gap-1">
        {Object.entries(d.anomalies?.by_label ?? {}).length === 0 && <span className="text-[11px] text-slate-400">ありません</span>}
        {Object.entries(d.anomalies?.by_label ?? {}).map(([k, v]) => (
          <span key={k} className="rounded bg-white px-1.5 py-0.5 text-[10px] text-slate-700 ring-1 ring-slate-200">{LABEL_JA[k] ?? k} {v.n}（当たり {v.hit}・外れ {v.false_alarm}・未確定 {v.pending}）</span>
        ))}
      </div>
      {(d.anomalies?.recent ?? []).filter((e) => e.arbiter).slice(0, 5).map((e) => (
        <div key={e.id} className="mb-1.5 rounded-lg bg-white px-2 py-1.5 text-[11px] ring-1 ring-slate-200">
          <div className="font-bold text-slate-700">💡 {name(e.property_customer_id)}さん・{SITE_JA[e.site ?? ""] ?? e.site}・{fmt(e.created_at)}：{e.arbiter?.reason_ja}</div>
          <div className="text-[10px] text-slate-500">正しいのは: {e.arbiter?.right}・抜け: {(e.arbiter?.missing ?? []).join("・") || "-"}・余計: {(e.arbiter?.extra ?? []).join("・") || "-"}・次: {e.arbiter?.next}</div>
          <div className="text-[10px] text-slate-400">意図: {e.arbiter?.intent} ／ 期待: {e.arbiter?.expect}</div>
          <div className="mt-1 flex gap-1.5">
            <button onClick={() => void reSearch(e.id)} className="rounded bg-[#1565C0] px-2 py-0.5 text-[10px] font-bold text-white">🔁 一時調整で再検索</button>
            <span className="text-[10px] text-slate-500">登録の条件を直すのは「ずっと」の言い直しの時だけ（お客様カードの条件から）</span>
          </div>
        </div>
      ))}

      <div className="mb-1 mt-2 text-[11px] font-bold text-slate-500">判断の流れ（直近30件）</div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-[10px]">
          <thead><tr className="text-left text-slate-400"><th>時刻</th><th>お客様</th><th>要所</th><th>①</th><th>②Jev</th><th>③</th><th>動き</th><th>$</th><th>実際</th></tr></thead>
          <tbody>
            {(d.events ?? []).map((e) => (
              <tr key={e.id} className={`border-t border-slate-100 ${e.final_label !== "normal" ? "bg-amber-50" : ""}`} title={e.material?.reason ?? e.action_reason ?? ""}>
                <td>{fmt(e.created_at).replace(/^\d+\/\d+ /, "")}</td>
                <td>{name(e.property_customer_id)}・{SITE_JA[e.site ?? ""] ?? e.site ?? ""}</td>
                <td>{CP_JA[e.checkpoint] ?? e.checkpoint}</td>
                <td>{LABEL_JA[e.det_label ?? ""] ?? e.det_label}{e.det_hard ? "（硬）" : ""}{e.material?.count != null ? `・${e.material.count}件` : ""}</td>
                <td>{e.jev_label ? `${LABEL_JA[e.jev_label] ?? e.jev_label}${e.jev_prob != null ? ` ${Math.round(e.jev_prob * 100)}%` : ""}` : "-"}</td>
                <td>{e.ds_label ? `${e.ds_image ? "📷" : ""}${LABEL_JA[e.ds_label] ?? e.ds_label}` : "-"}{e.arbiter ? "・裁定" : ""}</td>
                <td>{ACTION_JA[e.action ?? ""] ?? e.action}</td>
                <td>{e.cost_usd ? Number(e.cost_usd).toFixed(4) : "0"}{e.budget_state === "capped" ? "（上限）" : ""}</td>
                <td>{e.outcome ? OUTCOME_JA[e.outcome] ?? e.outcome : "…"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(d.events ?? []).length === 0 && <div className="py-2 text-center text-[11px] text-slate-400">まだ記録がありません（ブレインモードの検索から届きます）</div>}
      </div>
    </div>
  );
}

export default function ExtensionSnapshotsView() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [latest, setLatest] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [waiting, setWaiting] = useState<string>("");
  const [openLog, setOpenLog] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/extension-snapshots?view=latest&limit=6`, { cache: "no-store", headers: authHeader() }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "読み込めない");
      setDevices(r.devices ?? []); setSnaps(r.snapshots ?? []); setLatest(r.latest_ext_version ?? null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [load]);

  async function requestShot() {
    setErr("");
    const r = await fetch("/api/extension-snapshots", {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ action: "request", requested_by: "aix-tool" }),
    }).then((x) => x.json()).catch(() => ({ ok: false, error: "通信できない" }));
    if (!r.ok) { setErr(r.error ?? "頼めない"); return; }
    // 拡張は1分ごとに見に来る → 10秒おきに最大 90秒読み直す
    const reqId = r.id as number;
    const started = Date.now();
    setWaiting("拡張が撮るのを待っています（1分ほど）…");
    const poll = async () => {
      const x = await fetch(`/api/extension-snapshots?view=latest&limit=6&request_id=${reqId}`, { cache: "no-store", headers: authHeader() }).then((y) => y.json()).catch(() => null);
      if (x && x.ok && (x.snapshots ?? []).length > 0) { setWaiting(""); void load(); return; }
      if (Date.now() - started > 90_000) { setWaiting("90秒たっても届きません（拡張の PC が止まっている・版が 2.5.40 より古い可能性）"); void load(); return; }
      timer.current = setTimeout(() => { void poll(); }, 10_000);
    };
    timer.current = setTimeout(() => { void poll(); }, 10_000);
  }

  return (
    <>
      <ScreenWatchLive />
      <div className="mb-2 flex items-center gap-2">
        <button onClick={() => void requestShot()} disabled={!!waiting && waiting.endsWith("…")} className="rounded-lg bg-[#1565C0] px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50">📷 今の画面を撮る</button>
        <button onClick={() => void load()} className="rounded-lg bg-[#f0f2f5] px-2.5 py-1.5 text-[12px] font-bold text-[#54656f]">{loading ? "…" : "読み直す"}</button>
        {latest && <span className="ml-auto text-[11px] text-slate-500">今の拡張 v{latest}</span>}
      </div>
      {waiting && <div className="mb-2 rounded-lg bg-sky-50 px-3 py-2 text-[12px] text-sky-800">{waiting}</div>}
      {err && <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{err}</div>}

      <div className="mb-3">
        <div className="mb-1 text-[11px] font-bold text-slate-500">拡張を入れた PC（1分ごとの心拍）</div>
        {devices.length === 0 && !loading && <div className="text-[12px] text-slate-400">まだ心拍がありません（拡張 v2.5.40 以上を読み込んだ PC から届きます）</div>}
        {devices.map((d) => (
          <div key={d.install_id} className="mb-1.5 rounded-xl border border-[#e9edef] px-3 py-2 text-[12px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-bold text-slate-800">{d.device_label ?? `PC ${d.install_id.slice(0, 8)}`}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${d.outdated ? "bg-red-600 text-white" : "bg-emerald-100 text-emerald-700"}`}>v{d.ext_version ?? "?"}{d.outdated ? "（古い・再読み込み）" : ""}</span>
              {d.mode && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{MODE_JA[d.mode] ?? d.mode}</span>}
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${d.stale ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-500"}`}>{d.stale ? `応答なし（${ago(d.seen_ago_sec)}）` : `心拍 ${ago(d.seen_ago_sec)}`}</span>
              {!d.can_capture && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">写真の許可まだ（文字だけ）</span>}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-600">
              {d.batch_running
                ? `▶ 一括検索中 ${SITE_JA[d.current_site ?? ""] ?? d.current_site ?? ""}・待っている物: ${d.waiting_for ?? "?"}・最後に進んだ ${fmt(d.last_progress_at)}`
                : "待機中（一括の回は動いていない）"}
            </div>
          </div>
        ))}
      </div>

      <div className="mb-1 text-[11px] font-bold text-slate-500">最近撮った画面（14日で消えます）</div>
      {snaps.length === 0 && !loading && <div className="py-6 text-center text-[12px] text-slate-400">まだありません</div>}
      {snaps.map((s) => (
        <div key={s.id} className="mb-3 rounded-xl border border-[#e9edef] bg-white px-3 py-2 text-[12px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-bold text-slate-800">{fmt(s.created_at)}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{TRIGGER_JA[s.trigger ?? ""] ?? s.trigger}</span>
            <span className="text-[11px] text-slate-500">{s.device_label ?? `PC ${(s.install_id ?? "").slice(0, 8)}`} ・ v{s.ext_version ?? "?"} ・ {MODE_JA[s.mode ?? ""] ?? s.mode ?? ""}</span>
          </div>
          {s.stall?.why && <div className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-[11px] text-amber-900">{s.stall.why}</div>}
          {s.band_text && <div className="mt-1 text-[11px] text-slate-500">帯: {s.band_text}</div>}
          {s.error && <div className="mt-1 text-[11px] text-red-600">{s.error}</div>}
          {(s.tabs ?? []).map((t, i) => (
            <div key={i} className="mt-2 border-t border-[#f0f2f5] pt-1.5">
              <div className="text-[11px] font-bold text-slate-700">{SITE_JA[t.site ?? ""] ?? t.site}{t.active ? "（前に出ていた）" : "（裏のタブ）"}{t.activated_for_capture ? "・撮るために前に出した" : ""}{t.visibility ? `・${t.visibility}` : ""}</div>
              <div className="break-all text-[10px] text-slate-400">{t.url}</div>
              <div className="mt-0.5 text-[11px] text-slate-600">
                {[t.dom?.count_text && `件数「${t.dom.count_text}」`, t.dom?.page_text && `ページ「${t.dom.page_text}」`, t.dom?.selected_count && `選択 ${t.dom.selected_count}`, t.dom?.alert_text && `⚠ ${t.dom.alert_text}`].filter(Boolean).join(" ・ ") || (t.dom_error ? `文字が読めない: ${t.dom_error}` : "")}
              </div>
              {t.dom?.modal_text && <div className="mt-0.5 text-[11px] text-slate-600">開いていたモーダル: {t.dom.modal_text}</div>}
              {t.image_url
                ? <a href={t.image_url} target="_blank" rel="noreferrer"><img src={t.image_url} alt={`${t.site} の画面`} className="mt-1 w-full rounded-lg border border-[#e9edef]" /></a>
                : <div className="mt-0.5 text-[10px] text-slate-400">写真なし{t.image_error ? `（${t.image_error}）` : ""}</div>}
            </div>
          ))}
          {(s.log_tail ?? []).length > 0 && (
            <div className="mt-2">
              <button onClick={() => setOpenLog(openLog === s.id ? null : s.id)} className="text-[11px] font-bold text-[#1565C0]">{openLog === s.id ? "ログを閉じる" : `拡張のログ（最後の ${(s.log_tail ?? []).length} 行）`}</button>
              {openLog === s.id && (
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-900 p-2 text-[10px] leading-snug text-slate-100">
                  {(s.log_tail ?? []).map((l) => `${l.t ? new Date(l.t).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" }) : ""} ${l.l === "log" ? "" : `[${l.l}] `}${l.m ?? ""}`).join("\n")}
                </pre>
              )}
            </div>
          )}
          {(s.audit_run_id || s.batch_command_id) && <div className="mt-1 font-mono text-[10px] text-slate-400">{s.batch_command_id ? `命令 ${s.batch_command_id}` : ""}{s.audit_run_id ? ` ・ 点検 ${s.audit_run_id}` : ""}</div>}
        </div>
      ))}
    </>
  );
}
