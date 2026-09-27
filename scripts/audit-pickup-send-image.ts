// scripts/audit-pickup-send-image.ts
// お客様に送った・送る物件の画像が「元の資料のページそのまま」か、保存済みの資料（Vercel Blob の写し）で突き合わせる。
// 2026-09-27 竹内「物件はいま文字とか入れなおしてるけど、そのままの画像つかったら大丈夫」
//
// 物差し（2つの基準の画像を作り、近い方に分ける）:
//   ・元の資料＝このパソコンの Chrome（ヘッドレス）で PDF の1ページ目を pdfjs で描いた物（MS ゴシック＝資料を開いた時と同じ）
//   ・差し替え＝サーバーと同じ描き方（renderPdfPageToPng・Noto Sans JP に差し替え）
//   縮めた灰色の画素の平均の差（0〜255）で比べる。サイトには一切アクセスしない（Blob の写しだけ）。
//   ※ Windows のパソコンで Chrome がある時だけ動く（無ければ止まる）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-send-image.ts [--days=14] [--fix]
//   --fix: 送っていない（pending）行で、trim_image_url が元の資料でない（差し替え）物を null に戻す（次に売上サポで押した時に元の資料から作り直す）
import { createClient } from "@supabase/supabase-js";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderPdfPageToPng } from "../app/lib/pdf-render";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "14"));
const FIX = process.argv.includes("--fix");
const ROOT = process.cwd();
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => existsSync(p));

type Row = { id: number; created_at: string; site: string | null; status: string; property_name: string; room_no: string | null; pdf_blob_url: string | null; page_image_url: string | null; trim_image_url: string | null };

const HTML = `<!doctype html><meta charset="utf-8"><body><script type="module">
import * as pdfjs from "/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
const list = await (await fetch("/list")).json();
for (const id of list) {
  try {
    const data = new Uint8Array(await (await fetch("/pdf/" + id)).arrayBuffer());
    const task = pdfjs.getDocument({ data, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", useSystemFonts: true, fontExtraProperties: true });
    const pdf = await task.promise; const page = await pdf.getPage(1); const vp = page.getViewport({ scale: 2 });
    const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
    const tc = await page.getTextContent();
    const subs = [...new Set(Object.values(tc.styles).map((s) => s.fontSubstitution).filter(Boolean))];
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    await fetch("/out/" + id + "?subs=" + encodeURIComponent(JSON.stringify(subs)), { method: "POST", body: blob });
    await task.destroy();
  } catch (e) { await fetch("/out/" + id + "?err=" + encodeURIComponent(String(e)), { method: "POST", body: "" }); }
}
await fetch("/done", { method: "POST" });
</script>`;

async function chromeRender(pdfs: Map<number, Buffer>): Promise<Map<number, { png: Buffer | null; subs: string[]; err?: string }>> {
  if (!CHROME) throw new Error("Chrome が見つからない（Windows のパソコンで動かす）");
  const out = new Map<number, { png: Buffer | null; subs: string[]; err?: string }>();
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
        const id = Number(u.pathname.slice(5));
        const err = u.searchParams.get("err");
        out.set(id, { png: err ? null : Buffer.concat(chunks), subs: JSON.parse(u.searchParams.get("subs") ?? "[]"), err: err ?? undefined });
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
  const prof = mkdtempSync(join(tmpdir(), "audit-chrome-"));
  const ch = spawn(CHROME, ["--headless=new", "--disable-gpu", `--user-data-dir=${prof}`, `http://127.0.0.1:${port}/`], { stdio: "ignore" });
  const timer = setTimeout(done, 20_000 + pdfs.size * 8_000);
  await finished;
  clearTimeout(timer);
  ch.kill();
  server.close();
  try { rmSync(prof, { recursive: true, force: true }); } catch { /* Chrome が掴んでいる時は残る */ }
  return out;
}

const W = 1032, H = 729;
async function gray(buf: Buffer): Promise<Float32Array> {
  const img = await loadImage(buf);
  const c = createCanvas(W, H); const x = c.getContext("2d");
  x.drawImage(img, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data; const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return g;
}
const diff = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const sha = (b: Buffer) => createHash("sha1").update(b).digest("hex").slice(0, 12);
async function get(url: string): Promise<Buffer | null> { try { const r = await fetch(url); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; } catch { return null; } }

/**
 * 元の資料（Chrome の描画）との差で分ける。2026-09-27 の実測: 元の資料と同じ物は 0.97〜1.14、
 *   Noto Sans JP に差し替えた物（page_image_url）は 4.6〜6.7、MS ゴシックの無い端末で描いた物（1684×1189）は 5.5〜7.8 で、間が大きく空く。
 *   差し替えの基準（renderPdfPageToPng）は描いた時期の版（Noto の太さ）で揺れるので、分けるのには使わず参考に出すだけ
 */
function classify(dOrig: number, dSub: number, embedded: boolean): "元の資料" | "差し替え" {
  // 書体が埋め込みの資料（itandi）はサーバーの描画も元の字形（Chrome との差 1.7〜2.2 は画素の丸めの違い・サーバーとの差 0.5〜0.6）
  if (embedded) return dOrig < 2.5 || dSub < 1.0 ? "元の資料" : "差し替え";
  return dOrig < 2.0 ? "元の資料" : "差し替え";
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data, error } = await sb.from("property_pickups")
    .select("id, created_at, site, status, property_name, room_no, pdf_blob_url, page_image_url, trim_image_url")
    .gte("created_at", since).not("pdf_blob_url", "is", null).order("id");
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  // 送った画像（sent_properties の pickup_id 付き・image_url＝LINE に届いた画像）
  const { data: sentRows } = await sb.from("sent_properties").select("pickup_id, image_url, channel, sent_at").in("pickup_id", rows.map((r) => r.id));
  const sentBy = new Map<number, string[]>();
  for (const s of (sentRows ?? []) as Array<{ pickup_id: number; image_url: string | null }>) if (s.image_url) sentBy.set(s.pickup_id, [...(sentBy.get(s.pickup_id) ?? []), s.image_url]);
  const targets = rows.filter((r) => r.trim_image_url || r.status === "sent" || sentBy.has(r.id));
  console.log(`=== 資料 ${rows.length}件（${DAYS}日）・画像を確かめる行 ${targets.length}件（trim あり ${rows.filter((r) => r.trim_image_url).length}・送った ${rows.filter((r) => r.status === "sent").length}）===`);

  const pdfs = new Map<number, Buffer>();
  for (const r of targets) { const b = await get(r.pdf_blob_url!); if (b) pdfs.set(r.id, b); }
  const chrome = await chromeRender(pdfs);
  const tally: Record<string, number> = {};
  const toFix: number[] = [];
  for (const r of targets) {
    const pdf = pdfs.get(r.id);
    const ref = chrome.get(r.id);
    if (!pdf || !ref?.png) { console.log(`#${r.id} ${r.property_name}: 基準を作れない ${ref?.err ?? "PDF なし"}`); continue; }
    const sub = await renderPdfPageToPng(new Uint8Array(pdf), { page: 1, scale: 2, maxPixels: 4_000_000 });
    const gO = await gray(ref.png), gS = sub ? await gray(sub.png) : null;
    const embedded = ref.subs.length === 0;
    const line: string[] = [`#${r.id} ${r.site} ${r.status} ${r.property_name}${r.room_no ? ` ${r.room_no}` : ""} 書体=${embedded ? "埋め込み" : ref.subs.join("|")} サーバーの描いた文字=${sub?.textDraws}`];
    const check = async (label: string, url: string | null) => {
      if (!url) return null;
      const b = await get(url);
      if (!b) { line.push(`  ${label}: 取れない`); return null; }
      const g = await gray(b);
      const dO = diff(g, gO), dS = gS ? diff(g, gS) : 99;
      const k = classify(dO, dS, embedded);
      tally[`${label}:${k}`] = (tally[`${label}:${k}`] ?? 0) + 1;
      const img = await loadImage(b);
      line.push(`  ${label}: ${k}（元との差 ${dO.toFixed(2)}・差し替えとの差 ${dS.toFixed(2)}・${img.width}x${img.height}・${sha(b)}）`);
      return { k, hash: sha(b) };
    };
    const trim = await check("送る画像 trim", r.trim_image_url);
    await check("page_image_url", r.page_image_url);
    for (const u of sentBy.get(r.id) ?? []) {
      const s = await check("届いた画像", u);
      if (s && trim) line.push(`    届いた画像と trim のバイト: ${s.hash === trim.hash ? "同じ" : "違う"}${u === r.page_image_url ? "（page_image_url をそのまま送った）" : ""}`);
    }
    if (r.status === "pending" && trim && trim.k === "差し替え") toFix.push(r.id);
    console.log(line.join("\n"));
  }
  console.log("\n=== 集計 ===");
  console.log(tally);
  console.log(`送っていない行で trim が差し替え（--fix で null に戻す対象）: ${toFix.length}件 ${toFix.join(",")}`);
  if (FIX && toFix.length) {
    const { error: e } = await sb.from("property_pickups").update({ trim_image_url: null }).in("id", toFix).eq("status", "pending");
    console.log(e ? `戻せない: ${e.message}` : `trim_image_url を null に戻した: ${toFix.length}件`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
