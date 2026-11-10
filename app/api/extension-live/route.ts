// /api/extension-live — 別の PC で動いている拡張の様子をスマホで見る（2026-11-10 竹内）
//   読み取り専用（何も書き換えない・スマホから操作はできない）。新しい表・列は作らない。
//   GET ?view=live               … 今どうなっているか（JSON・20秒ごとに取り直す想定）
//   GET ?install=<install_id>    … 1台に絞る
//   GET ?format=html             … スマホでそのまま開ける画面（同じ口を HTML で返す）
//   認証: 今の見張りの画面と同じ内部認証（Authorization: Bearer INTERNAL_API_SECRET）
//        ?key=<INTERNAL_API_SECRET> も受ける（スマホのブラウザから開く時にヘッダを付けられないため）
import { NextRequest, NextResponse } from "next/server";
import { liveDevices } from "@/app/lib/extension-live-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function authOk(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return false;
  const h = req.headers.get("authorization");
  if (h === `Bearer ${secret}`) return true;
  const k = req.nextUrl.searchParams.get("key");
  return !!k && k === secret;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const install = req.nextUrl.searchParams.get("install");
  const r = await liveDevices({ install: install && /^[A-Za-z0-9_-]{1,64}$/.test(install) ? install : null });
  if (req.nextUrl.searchParams.get("format") !== "html") {
    return NextResponse.json(r, { status: r.ok ? 200 : 500, headers: { "Cache-Control": "no-store" } });
  }
  return new NextResponse(html(r), {
    status: r.ok ? 200 : 500,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const esc = (v: unknown): string => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

function html(r: Record<string, unknown>): string {
  const s = (r.summary ?? {}) as Record<string, number>;
  const devices = (r.devices ?? []) as Array<Record<string, unknown>>;
  const audits = (r.audits ?? []) as Array<Record<string, unknown>>;
  const commands = (r.commands ?? []) as Array<Record<string, unknown>>;
  const alerts = (r.watch_alerts ?? []) as Array<Record<string, unknown>>;
  const badge = (t: string, cls: string) => `<span class="b ${cls}">${esc(t)}</span>`;

  const devRows = devices.map((d) => {
    const cls = d.stale ? "off" : d.stuck ? "warn" : d.running ? "on" : "idle";
    const state = d.stale ? "止まっている" : d.stuck ? "進んでいない（止まった疑い）" : d.running ? "動いている" : "待機";
    return `<div class="card ${cls}">
      <div class="row"><b>${esc(d.label)}</b>${badge(state, cls)}</div>
      <div class="muted">v${esc(d.version)} ・ ${esc(d.mode)} ・ 心拍 ${esc(d.since)}</div>
      ${d.running ? `<div class="row">お客様: <b>${esc(d.customer_name || (d.customer_id ? String(d.customer_id).slice(0, 8) : "—"))}</b> ・ ${esc(d.site || "")}</div>` : ""}
      ${d.waiting_for ? `<div>待っている事: ${esc(d.waiting_for)}</div>` : ""}
      ${d.running ? `<div class="muted">開始 ${esc(d.batch_started || "—")} ・ 最後に進んだ ${esc(d.last_progress || "—")}</div>` : ""}
    </div>`;
  }).join("");

  const auditRows = audits.slice(0, 12).map((a) => `<div class="card ${a.error ? "warn" : a.done ? "idle" : "on"}">
      <div class="row"><b>${esc(a.customer_name || (a.customer_id ? String(a.customer_id).slice(0, 8) : "—"))}</b>
        ${badge(String(a.site || ""), "idle")}<span class="muted">${esc(a.since)}</span></div>
      <div class="muted">${esc(a.status)}${a.done ? "・終わり" : "・実行中"}${a.pages != null ? ` ・${esc(a.pages)}ページ` : ""}${a.rows != null ? ` ・${esc(a.rows)}行` : ""}${a.sent != null ? ` ・送信${esc(a.sent)}` : ""}</div>
      ${a.human_judge ? `<div class="${a.human_n ? "" : "err"}">👤 ${esc(a.human_judge)}${a.human_gap ? ` ・間 ${esc(Math.round(Number(a.human_gap)))}ms` : ""}</div>` : ""}
      ${a.last_step ? `<div>今: ${esc(a.last_step)}</div>` : ""}
      ${a.error ? `<div class="err">${esc(a.error)}</div>` : ""}
      <details><summary class="muted">操作の記録（${(a.steps as unknown[] | undefined)?.length ?? 0}件）</summary>
        ${((a.steps ?? []) as Array<Record<string, unknown>>).map((x) => `<div class="muted">・${esc(x.k)}${x.d ? " … " + esc(x.d) : ""}</div>`).join("")}
      </details>
    </div>`).join("");

  const cmdRows = commands.slice(0, 10).map((c) => `<div class="card ${c.status === "error" ? "warn" : "idle"}">
      <div class="row">${badge(String(c.status), c.status === "error" ? "warn" : "idle")}<span class="muted">${esc(c.created_at)}</span></div>
      <div class="muted">${esc((c.sites as string[] | undefined)?.join("・") || "")} ・ お客様 ${esc(c.customers)}人${c.source ? " ・ " + esc(c.source) : ""}${c.aix_action ? " / " + esc(c.aix_action) : ""}</div>
      ${c.error ? `<div class="err">${esc(c.error)}</div>` : ""}
    </div>`).join("");

  const alertRows = alerts.map((w) => `<div class="card warn"><div class="row"><b>${esc(w.label)}</b><span class="muted">${esc(w.since || w.at)}</span></div>
      <div class="muted">${esc(w.site)} ・ ${esc(w.checkpoint)}${w.customer_name ? " ・ " + esc(w.customer_name) : ""}</div>
      ${w.reason ? `<div>${esc(w.reason)}</div>` : ""}</div>`).join("");

  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>物件検索の稼働（スマホ）</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;padding:12px;background:#f5f6f8;color:#111}
@media (prefers-color-scheme:dark){body{background:#111418;color:#e6e8eb}.card{background:#1a1f25!important;border-color:#2a323b!important}}
h1{font-size:17px;margin:4px 0 10px}
.sum{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.pill{background:#fff;border:1px solid #dde1e6;border-radius:999px;padding:4px 10px;font-size:13px}
.card{background:#fff;border:1px solid #dde1e6;border-radius:10px;padding:10px 12px;margin-bottom:8px}
.card.on{border-left:5px solid #16a34a}.card.warn{border-left:5px solid #f59e0b}.card.off{border-left:5px solid #94a3b8}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.muted{color:#64748b;font-size:12.5px}
.err{color:#b91c1c;font-size:13px;word-break:break-word}
.b{font-size:11.5px;border-radius:999px;padding:1px 8px;background:#e2e8f0;color:#334155}
.b.on{background:#dcfce7;color:#166534}.b.warn{background:#fef3c7;color:#92400e}.b.off{background:#e2e8f0;color:#475569}
h2{font-size:14px;margin:16px 0 6px;color:#334155}
details{margin-top:4px}
</style></head><body>
<h1>🔍 物件検索の稼働（20秒ごとに更新）</h1>
<div class="sum">
  <span class="pill">PC ${s.devices ?? 0}台</span>
  <span class="pill">動いている ${s.running ?? 0}</span>
  <span class="pill">止まっている ${s.stale ?? 0}</span>
  ${s.stuck ? `<span class="pill">⚠ 進んでいない ${s.stuck}</span>` : ""}
  <span class="pill">指示待ち ${s.pending_commands ?? 0}</span>
  ${s.error_commands ? `<span class="pill">⚠ 失敗 ${s.error_commands}</span>` : ""}
</div>
<h2>PC（別の PC の様子）</h2>${devRows || '<div class="muted">まだ心拍がありません</div>'}
<h2>直近の検索</h2>${auditRows || '<div class="muted">15分以内の検索はありません</div>'}
${alertRows ? `<h2>見張りの印</h2>${alertRows}` : ""}
<h2>指示（たまっている物）</h2>${cmdRows || '<div class="muted">ありません</div>'}
<p class="muted">※ この画面は見るだけです（ここから止める・動かすはできません）。</p>
</body></html>`;
}
