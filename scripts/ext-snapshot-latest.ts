// scripts/ext-snapshot-latest.ts — 拡張の「今の画面」の最新を落として読む（2026-09-29 v2.5.40）
//   竹内「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
//   PC ごとの心拍（版・モード・実行中の回）と、最新の撮った物（止まり／頼まれ）の文字を出し、写真を --out に落とす（Read で見る）。
//
// 実行（読むだけ）:
//   npx tsx --env-file=.env.local --env-file=.env.prod scripts/ext-snapshot-latest.ts [--limit=3] [--install=<install_id>] [--out=<dir>]
//   --request … 先に「今の画面を撮る」を頼み、最大 90秒 答えを待つ（extension_snapshots に頼まれの行を1つ書く＝これだけが書き込み）
// 読み方: SUPABASE_SERVICE_ROLE_KEY があれば DB を直接（表は RLS 有効・ポリシーなし）、無ければ本番の API（Bearer INTERNAL_API_SECRET）
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deviceView, type DeviceRow } from "../app/lib/extension-snapshots";
import manifest from "../chrome-extension/manifest.json";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const limit = Math.min(Math.max(Number(arg("limit", "3")) || 3, 1), 20);
const install = arg("install") || null;
const outDir = arg("out") || join(tmpdir(), "ext-snapshots");
const doRequest = process.argv.includes("--request");
const API = process.env.EXT_SNAPSHOT_API ?? "https://sumora-ai-ui.vercel.app";
const LATEST = (manifest as { version?: string }).version ?? null;

type Snap = Record<string, unknown> & { id: number; created_at: string; tabs?: Array<Record<string, unknown>> | null; log_tail?: Array<{ t: number | null; l: string | null; m: string | null }> | null };

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const secret = process.env.INTERNAL_API_SECRET;
const sb = serviceKey && process.env.NEXT_PUBLIC_SUPABASE_URL ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey) : null;

async function viaApi(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  if (!secret) throw new Error("SUPABASE_SERVICE_ROLE_KEY も INTERNAL_API_SECRET も無い（--env-file=.env.prod を足す）");
  const r = await fetch(`${API}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...(init?.headers ?? {}) } });
  const j = (await r.json()) as Record<string, unknown>;
  if (!r.ok || j.ok === false) throw new Error(`API ${r.status}: ${String(j.error ?? "")}`);
  return j;
}

async function load(requestId: number | null): Promise<{ devices: ReturnType<typeof deviceView>[]; snapshots: Snap[] }> {
  if (sb) {
    const { data: devs, error: dErr } = await sb.from("extension_devices").select("*").order("last_seen_at", { ascending: false }).limit(20);
    if (dErr) throw new Error(`extension_devices: ${dErr.message}`);
    let q = sb.from("extension_snapshots").select("*").eq("kind", "result").order("created_at", { ascending: false }).limit(limit);
    if (install) q = q.eq("install_id", install);
    if (requestId != null) q = q.eq("request_id", requestId);
    const { data: snaps, error: sErr } = await q;
    if (sErr) throw new Error(`extension_snapshots: ${sErr.message}`);
    return { devices: ((devs ?? []) as DeviceRow[]).map((d) => deviceView(d, LATEST, Date.now())), snapshots: (snaps ?? []) as Snap[] };
  }
  const qs = new URLSearchParams({ view: "latest", limit: String(limit) });
  if (install) qs.set("install_id", install);
  if (requestId != null) qs.set("request_id", String(requestId));
  const j = await viaApi(`/api/extension-snapshots?${qs}`);
  return { devices: (j.devices ?? []) as ReturnType<typeof deviceView>[], snapshots: (j.snapshots ?? []) as Snap[] };
}

async function request(): Promise<number> {
  if (sb) {
    const { data, error } = await sb.from("extension_snapshots").insert({ kind: "request", status: "requested", trigger: "request", requested_by: "script", install_id: install }).select("id").single();
    if (error) throw new Error(error.message);
    return (data as { id: number }).id;
  }
  const j = await viaApi("/api/extension-snapshots", { method: "POST", body: JSON.stringify({ action: "request", requested_by: "script", install_id: install }) });
  return Number(j.id);
}

const jst = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "-");

async function main() {
  let requestId: number | null = null;
  if (doRequest) {
    requestId = await request();
    console.log(`頼んだ request_id=${requestId}（拡張は1分ごとに見に来る）`);
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 10_000));
      const got = await load(requestId);
      if (got.snapshots.length > 0) break;
      if (Date.now() - t0 > 90_000) { console.log("90秒たっても答えが無い（PC が止まっている・v2.5.40 より古い・許可以前に心拍が来ていない）"); requestId = null; break; }
      process.stdout.write(".");
    }
    console.log("");
  }
  const { devices, snapshots } = await load(requestId);
  console.log(`=== PC（今の拡張 v${LATEST}） ===`);
  for (const d of devices) {
    console.log(`- ${d.device_label ?? d.install_id.slice(0, 8)} v${d.ext_version ?? "?"}${d.outdated ? "【古い】" : ""} ${d.mode ?? "?"} 心拍 ${d.seen_ago_sec}秒前${d.stale ? "【応答なし】" : ""}`
      + ` ${d.batch_running ? `▶一括 ${d.current_site ?? ""} 待ち=${d.waiting_for ?? "?"} 最後に進んだ ${jst(d.last_progress_at)}` : "待機中"} 写真の許可=${d.can_capture ? "あり" : "なし"}`);
  }
  mkdirSync(outDir, { recursive: true });
  console.log(`\n=== 撮った物 ${snapshots.length}件（写真は ${outDir}） ===`);
  for (const s of snapshots) {
    console.log(`\n■ #${s.id} ${jst(s.created_at)} trigger=${String(s.trigger)} v${String(s.ext_version ?? "?")} ${String(s.mode ?? "")} 命令=${String(s.batch_command_id ?? "-")} 点検=${String(s.audit_run_id ?? "-")}`);
    const stall = s.stall as { why?: string } | null;
    if (stall?.why) console.log(`  理由: ${stall.why}`);
    if (s.band_text) console.log(`  帯: ${String(s.band_text)}`);
    if (s.error) console.log(`  エラー: ${String(s.error)}`);
    for (const t of s.tabs ?? []) {
      const dom = (t.dom ?? {}) as Record<string, unknown>;
      console.log(`  [${String(t.site)}] ${t.active ? "前" : "裏"} ${String(t.visibility ?? "")} ${String(t.url ?? "")}`);
      console.log(`    件数=${String(dom.count_text ?? "-")} ページ=${String(dom.page_text ?? "-")} 選択=${String(dom.selected_count ?? "-")} ⚠=${String(dom.alert_text ?? "-")} モーダル=${String(dom.modal_text ?? "-").slice(0, 120)}`);
      if (typeof t.image_url === "string") {
        const r = await fetch(t.image_url);
        if (r.ok) {
          const f = join(outDir, `snap_${s.id}_${String(t.site)}.jpg`);
          writeFileSync(f, Buffer.from(await r.arrayBuffer()));
          console.log(`    写真: ${f}`);
        } else console.log(`    写真を落とせない HTTP ${r.status}`);
      } else console.log(`    写真なし（${String(t.image_error ?? "-")}）`);
    }
    const tail = (s.log_tail ?? []).slice(-15);
    if (tail.length) {
      console.log("  ログの末尾:");
      for (const l of tail) console.log(`    ${l.t ? new Date(l.t).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" }) : ""} ${l.l === "log" ? "" : `[${l.l}] `}${l.m ?? ""}`);
    }
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
