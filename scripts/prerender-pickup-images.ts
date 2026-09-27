// scripts/prerender-pickup-images.ts
// 送る画像がまだ無いピックアップの行を、このパソコンの Chrome（ヘッドレス・MS ゴシックあり）で「元の資料の1ページ目そのまま」の画像にして保存する。
// 2026-09-27 竹内「なぜ送れないのか？画像をそのままの蓮産業の画像で保存していたらそのまま使える。ここちゃんとできるようにする」
//   ふだんは拡張（v2.5.33〜）の裏の画面と、パソコンで売上サポを開いた時に作られる（/pickup-prerender）。これはその前の行を埋める・確かめる道具。
//   描き方は画面の renderOriginalPageInBrowser と同じ（pdfjs・useSystemFonts・切り取りなし・scale 2・JPEG 0.9）。
//   資料が求める書体（fontSubstitution）がこの Chrome に無ければ作らない（元の見た目でない画像を作らない）。
//   置き場は本番の /api/property-pickups/trim（images）＝画面と同じ道。サイト（リアプロ・itandi）には触れない（Vercel Blob の写しの PDF だけ）
//
// 実行: npx tsx --env-file=.env.prod scripts/prerender-pickup-images.ts [--ids=628,706] [--days=7] [--dry]
//   ※ .env.prod（INTERNAL_API_SECRET＝置く時に本番の trim を呼ぶ）が要る。Windows の Chrome が要る
import { createClient } from "@supabase/supabase-js";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { needsPrerender, PRERENDER_MAX_AGE_DAYS } from "../app/lib/pickup-send-image";
import { chunkTrimImages } from "../app/lib/pickup-aix-handoff";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const IDS = arg("ids").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const DAYS = Number(arg("days", String(PRERENDER_MAX_AGE_DAYS)));
const DRY = process.argv.includes("--dry");
const BASE = arg("base", "https://sumora-ai-ui.vercel.app");
const ROOT = process.cwd();
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));

// pdf-trim-browser.ts の renderOriginalPageInBrowser・isLocalFontFamilyAvailable と同じ描き方・同じ書体の確かめ
const HTML = `<!doctype html><meta charset="utf-8"><body><script type="module">
import * as pdfjs from "/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
function has(family) {
  const c = document.createElement("canvas").getContext("2d");
  const sample = "物件名 賃料 wiIl1 0123 ｱｲｳ 難波ＷＩ";
  for (const base of ["monospace", "serif", "sans-serif"]) {
    c.font = "40px " + base; const w0 = c.measureText(sample).width;
    c.font = '40px "' + family.replace(/"/g, "") + '", ' + base;
    if (c.measureText(sample).width !== w0) return true;
  }
  return false;
}
const list = await (await fetch("/list")).json();
for (const id of list) {
  try {
    const data = new Uint8Array(await (await fetch("/pdf/" + id)).arrayBuffer());
    const task = pdfjs.getDocument({ data, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", useSystemFonts: true, fontExtraProperties: true });
    const pdf = await task.promise; const page = await pdf.getPage(1); const vp = page.getViewport({ scale: 2 });
    const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    let draws = 0; const f0 = ctx.fillText.bind(ctx); ctx.fillText = (...a) => { draws++; f0(...a); };
    await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
    const tc = await page.getTextContent();
    const fams = [...new Set(Object.values(tc.styles).map((s) => String(s.fontSubstitution || "").split(",")[0].trim().replace(/^["']|["']$/g, "")).filter((f) => f && !/^g_d\\d+_/.test(f) && !/^(serif|sans-serif|monospace)$/i.test(f)))];
    const missing = fams.filter((f) => !has(f));
    if (missing.length) { await fetch("/out/" + id + "?err=" + encodeURIComponent("この Chrome に書体が無い: " + missing.join("・")), { method: "POST", body: "" }); await task.destroy(); continue; }
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    await fetch("/out/" + id + "?fams=" + encodeURIComponent(fams.join("|")) + "&draws=" + draws, { method: "POST", body: blob });
    await task.destroy();
  } catch (e) { await fetch("/out/" + id + "?err=" + encodeURIComponent(String(e)), { method: "POST", body: "" }); }
}
await fetch("/done", { method: "POST" });
</script>`;

type Out = { jpeg: Buffer | null; fams: string; draws: number; err?: string };
async function chromeRender(pdfs: Map<number, Buffer>): Promise<Map<number, Out>> {
  if (!CHROME) throw new Error("Chrome が見つからない（Windows のパソコンで動かす）");
  const out = new Map<number, Out>();
  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const types: Record<string, string> = { mjs: "text/javascript", bcmap: "application/octet-stream", pfb: "application/octet-stream", ttf: "font/ttf" };
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); return res.end(HTML); }
    if (u.pathname === "/list") return res.end(JSON.stringify([...pdfs.keys()]));
    if (u.pathname.startsWith("/pdf/")) { res.setHeader("Content-Type", "application/pdf"); return res.end(pdfs.get(Number(u.pathname.slice(5)))); }
    if (u.pathname.startsWith("/out/")) {
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        const err = u.searchParams.get("err");
        out.set(Number(u.pathname.slice(5)), { jpeg: err ? null : Buffer.concat(chunks), fams: u.searchParams.get("fams") ?? "", draws: Number(u.searchParams.get("draws") ?? 0), err: err ?? undefined });
        res.end("ok");
      });
      return;
    }
    if (u.pathname === "/done") { res.end("ok"); done(); return; }
    const f = u.pathname === "/pdf.mjs" ? join(ROOT, "node_modules/pdfjs-dist/build/pdf.min.mjs") : u.pathname.startsWith("/pdfjs/") ? join(ROOT, "public", decodeURIComponent(u.pathname)) : "";
    try { const b = readFileSync(f); res.setHeader("Content-Type", types[f.split(".").pop() ?? ""] ?? "application/octet-stream"); res.end(b); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const prof = mkdtempSync(join(tmpdir(), "prerender-chrome-"));
  const ch = spawn(CHROME, ["--headless=new", "--disable-gpu", `--user-data-dir=${prof}`, `http://127.0.0.1:${port}/`], { stdio: "ignore" });
  const timer = setTimeout(done, 20_000 + pdfs.size * 8_000);
  await finished;
  clearTimeout(timer);
  ch.kill();
  server.close();
  try { rmSync(prof, { recursive: true, force: true }); } catch { /* Chrome が掴んでいる時は残る */ }
  return out;
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  let q = sb.from("property_pickups").select("id, created_at, status, expired_at, site, customer_name, property_name, room_no, pdf_blob_url, trim_image_url");
  q = IDS.length ? q.in("id", IDS) : q.gte("created_at", since).is("trim_image_url", null).eq("status", "pending");
  const { data, error } = await q.order("id");
  if (error) throw error;
  type Row = { id: number; created_at: string; status: string; expired_at: string | null; site: string | null; customer_name: string | null; property_name: string; room_no: string | null; pdf_blob_url: string | null; trim_image_url: string | null };
  // 日数は --days（既定は画面と同じ PRERENDER_MAX_AGE_DAYS）で問い合わせの時に切った。残りの決まり（PDF あり・画像なし・未送信・期限内）は needsPrerender と同じ
  const rows = ((data ?? []) as Row[]).filter((r) => needsPrerender({ ...r, created_at: new Date().toISOString() }));
  console.log(`=== 作る行 ${rows.length}件（${IDS.length ? `指定 ${IDS.join(",")}` : `${DAYS}日以内・未送信・画像なし`}）${DRY ? "・--dry（置かない）" : ""} ===`);
  if (rows.length === 0) return;
  const pdfs = new Map<number, Buffer>();
  for (const r of rows) { try { const res = await fetch(r.pdf_blob_url!); if (res.ok) pdfs.set(r.id, Buffer.from(await res.arrayBuffer())); } catch { /* 下で「資料を取れない」 */ } }
  const outs = await chromeRender(pdfs);
  const images: Array<{ id: number; jpeg_base64: string }> = [];
  for (const r of rows) {
    const o = outs.get(r.id);
    const head = `#${r.id} ${r.site} ${r.customer_name ?? ""} ${r.property_name}${r.room_no ? ` ${r.room_no}` : ""}`;
    if (!pdfs.has(r.id)) { console.log(`${head}: 資料を取れない`); continue; }
    if (!o?.jpeg) { console.log(`${head}: 作らない（${o?.err ?? "描けない"}）`); continue; }
    console.log(`${head}: 描いた（書体 ${o.fams || "埋め込み"}・描いた文字 ${o.draws}・${Math.round(o.jpeg.length / 1024)}KB）`);
    images.push({ id: r.id, jpeg_base64: o.jpeg.toString("base64") });
  }
  if (DRY || images.length === 0) return;
  for (const chunk of chunkTrimImages(images)) {
    const res = await fetch(`${BASE}/api/property-pickups/trim`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.INTERNAL_API_SECRET ?? ""}` },
      body: JSON.stringify({ images: chunk }),
    });
    const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as { trimmed?: number; items?: Array<{ id: number; trim_image_url?: string | null; error?: string }>; error?: string };
    for (const it of j.items ?? []) console.log(`  置いた #${it.id}: ${it.trim_image_url ?? `できない ${it.error}`}`);
    if (!j.items) console.log(`  置けない: ${j.error}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
