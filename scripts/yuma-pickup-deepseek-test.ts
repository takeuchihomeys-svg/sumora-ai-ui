// YUMA（テスト用会話）で「ブレインモードのピックアップ → DeepSeek の判断 → トリミングした物件資料」を本番と同じ関数で通す
// 2026-09-24 竹内「DeepSeek の API でちゃんとできているか YUMA でテスト。物件資料は物件ピックアップや物件オススメの画像で送られているように」
//
// 本番と同じ関数: enrichSummariesWithPdfAd / rankAndAnnotateSummaries（DeepSeek・app/lib/pickup-rank.ts）、
//   readPropertyImageDetail（DeepSeek・元付の2ページ目）、cropRectForSheet / trimSheetImage（上86%）
// 違う所（ローカルにはブラウザも Blob の鍵も無い）:
//   - 1ページ目は「このパソコンのフォント」で描く（画面の ✂️ と同じ見た目）
//   - 画像の置き場は AIX の物件画像と同じ Supabase の property-images/aix/<会話>/（LINE に送れる公開 URL）
// LINE への送信は売上サポの「📤 AIXで送る」→ AIX【物件ピックアップした】（直接の送信＝/api/property-pickups/send の action:"send" は 2026-09-24 に廃止・410）
// 実行: npx tsx --env-file=.env.local scripts/yuma-pickup-deepseek-test.ts --out=<dir> [--n=3] | --cleanup=1
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderPdfPageToPng } from "../app/lib/pdf-render";
import { trimSheetImage } from "../app/lib/pdf-trim";
import { enrichSummariesWithPdfAd, rankAndAnnotateSummaries, buildRankMaterials } from "../app/lib/pickup-rank";
import { readPropertyImageDetail } from "../app/lib/property-image-read";
import { parseRecommendMark, CUSTOMER_PAGE, AGENT_PAGE } from "../app/lib/property-pickups";
// 2026-09-24 画像で分析を作り直した（型の前置き・間取り図の切り出し・物件ごとの保存）→ 本番と同じ analyzePickupRow を使う
import { pickBest } from "../app/lib/pickup-image-analysis";
import { analyzePickupRow } from "../app/lib/pickup-analyze-server";
import { extractImageWants } from "../app/lib/image-wants";
import type { SheetSourceRow } from "../app/lib/sheet-read-server";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const OUT = arg("out") ?? ".";
const N = Number(arg("n") ?? "3");
const BUCKET = "property-images";

async function cleanup() {
  const { data } = await sb.from("property_pickups").delete().eq("conversation_id", YUMA).like("batch_id", "YUMA_%").select("id");
  console.log(`YUMA のテスト行 ${(data ?? []).length}件を消した`);
}

async function upload(path: string, buf: Buffer, type: string): Promise<string> {
  const { error } = await sb.storage.from(BUCKET).upload(path, buf, { contentType: type, upsert: true });
  if (error) throw new Error(`upload ${path}: ${error.message}`);
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function main() {
  if (arg("cleanup") === "1") { await cleanup(); return; }
  await cleanup();
  mkdirSync(OUT, { recursive: true });
  const startedIso = new Date().toISOString();

  // 本物の物件（直近のピックアップの PDF）を借りる。説明文の 🌟 は外して DeepSeek に付け直させる
  const { data: src } = await sb.from("property_pickups").select("property_name, room_no, summary_text, pdf_blob_url")
    .not("pdf_blob_url", "is", null).neq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(N);
  const rows = (src ?? []) as Array<{ property_name: string; room_no: string | null; summary_text: string; pdf_blob_url: string }>;
  if (!rows.length) { console.log("借りる物件が無い"); return; }
  const summaries = rows.map((r, i) => r.summary_text.replace(/^【\d+[^】]*】/u, `【${i + 1}】`).replace(/\n🧠[\s\S]*$/u, ""));
  const b64 = await Promise.all(rows.map(async (r) => Buffer.from(await (await fetch(r.pdf_blob_url)).arrayBuffer()).toString("base64")));

  // ① 資料から AD を補う → ② DeepSeek で 🌟（本番 merge-pdfs と同じ関数）
  const withAd = await enrichSummariesWithPdfAd(summaries, b64);
  // 2026-09-25 本番の merge-pdfs と同じく資料の表の1行（敷礼・築年・入居・設備）を🌟の判断に渡す
  const ranked = await rankAndAnnotateSummaries(withAd, "家賃〜10万円 / 1LDK / 敷礼なるべく0", await buildRankMaterials(b64));
  console.log("\n=== DeepSeek の順位付け ===");
  ranked.forEach((s) => console.log("  " + s.split("\n").slice(0, 2).join(" / ")));

  const stamp = Date.now();
  const batchId = `YUMA_pickup_test_${stamp}.pdf`;
  const inserts = [];
  for (let i = 0; i < rows.length; i++) {
    // ③ 1ページ目（弊社）を描いて上86%で切る＝お客様に送る画像 ／ ④ 2ページ目（元付）＝ DeepSeek が読む
    const p1 = await renderPdfPageToPng(b64[i], { page: CUSTOMER_PAGE, scale: 2, maxPixels: 4_000_000, systemFonts: true });
    const p2 = await renderPdfPageToPng(b64[i], { page: AGENT_PAGE, scale: 1.5, systemFonts: true });
    const trimmed = p1 ? await trimSheetImage(p1.png) : null;
    if (!trimmed) { console.log(`【${i + 1}】トリミングできない`); continue; }
    writeFileSync(join(OUT, `yuma_trim_${i + 1}.jpg`), trimmed.jpeg);
    const trimUrl = await upload(`aix/${YUMA}/pickup_test_${stamp}_${i + 1}_trim.jpg`, trimmed.jpeg, "image/jpeg");
    const agentUrl = p2 ? await upload(`aix/${YUMA}/pickup_test_${stamp}_${i + 1}_agent.png`, p2.png, "image/png") : null;
    const detail = agentUrl ? await readPropertyImageDetail(agentUrl, { timeoutMs: 40_000 }) : { kind: "other", lines: [] as string[] };
    console.log(`\n【${i + 1}】${rows[i].property_name} トリミング ${trimmed.width}x${trimmed.height} ／ DeepSeek（元付）kind=${detail.kind} ${detail.lines.length}行`);
    detail.lines.slice(0, 6).forEach((l) => console.log("    📷 " + l));
    const mark = parseRecommendMark(ranked[i]);
    inserts.push({
      batch_id: batchId, property_customer_id: null, conversation_id: YUMA, customer_name: "YUMA", site: "realpro",
      rank: i + 1, property_name: rows[i].property_name, room_no: rows[i].room_no, summary_text: ranked[i],
      pdf_url: null, pdf_blob_url: rows[i].pdf_blob_url, pdf_text: null, pdf_has_text: false,
      verdict: "pass", score: null, reason_codes: [], reasons_ja: [], ad_yen: null, profit_yen: null,
      recommended: mark.recommended, status: "pending",
      page_image_url: trimUrl, trim_image_url: trimUrl, agent_image_url: agentUrl,
      image_lines: detail.lines.length ? detail.lines : null, image_facts: null,
    });
  }
  const { data: ins, error } = await sb.from("property_pickups").insert(inserts).select("id, rank, site, property_name, conversation_id, summary_text, pdf_url, pdf_blob_url, pdf_text, pdf_has_text, trim_image_url, page_image_url, image_analysis");
  if (error) { console.log("insert 失敗:", error.message); return; }
  console.log(`\nYUMA のピックアップ ${(ins ?? []).length}件を作成（batch=${batchId}）`);

  // ⑥ 🔍 画像で分析（本番の /analyze と同じ関数・お客様に送る1ページ目だけを読む）
  const wants = extractImageWants({ staffNote: "水回りはバス・トイレ別と独立洗面台が良い／キッチンは対面が良い／リビングと寝室（洋室）は離れている方が良い／ウォークインクローゼットが欲しい" });
  console.log("\n=== 🔍 画像で分析（DeepSeek）===");
  const analyzed = await Promise.all(((ins ?? []) as Array<SheetSourceRow & { rank: number; property_name: string; conversation_id: string | null }>).map(async (r) => {
    const t = Date.now();
    const out = await analyzePickupRow(r, wants);
    if (out.analysis) await sb.from("property_pickups").update({ image_analysis: { ...out.analysis, wants, analyzed_at: new Date().toISOString() } }).eq("id", r.id);
    console.log(`\n【${r.rank}】${r.property_name} ${Date.now() - t}ms source=${out.facts.source} model=${out.usage.map((u) => u.model).join(",") || "-"} ${out.analysis ? `${out.analysis.match}点` : "読めなかった"}`);
    if (out.analysis) {
      const a = out.analysis;
      console.log(`    🚿 ${a.water}\n    🍳 ${a.kitchen}\n    🛋️ ${a.layout}\n    🧥 ${a.storage}\n    ◎ ${a.good.join("／")}\n    △ ${a.concern.join("／")}`);
    }
    return { id: r.id, rank: r.rank, property_name: r.property_name, analysis: out.analysis };
  }));
  const best = pickBest(analyzed);
  console.log(`\n👑 一番条件に合う: ${best ? `【${best.rank}】${best.property_name}` : "（決められない）"}`);
  console.log(`\nAIX に渡す URL（売上サポの「📤 AIXで送る」と同じ）: /?conv=${YUMA}&aix=property_send&pickup=${((ins ?? []) as Array<{ id: number }>).map((r) => r.id).join(",")}&batch=${batchId}`);

  // ⑤ DeepSeek に本当に行ったか（llm_usage_logs）
  await new Promise((r) => setTimeout(r, 4000));
  const { data: logs } = await sb.from("llm_usage_logs").select("action, model, status, error_type, input_uncached, cache_read, output_tokens")
    .gte("created_at", startedIso).in("action", ["property_rank", "property_image_detail", "property_image_read"]);
  console.log("\n=== llm_usage_logs（このテスト中）===");
  for (const l of (logs ?? []) as Array<Record<string, unknown>>) console.log(`  ${l.action} model=${l.model} status=${l.status} err=${l.error_type ?? "-"} in=${l.input_uncached} read=${l.cache_read} out=${l.output_tokens}`);
  const claude = ((logs ?? []) as Array<{ model: string }>).filter((l) => /claude/i.test(l.model)).length;
  console.log(claude ? `⚠ Claude に行った行が ${claude}件` : "Claude には行っていない（全部 DeepSeek）");
}
main().catch((e) => { console.error(e); process.exit(1); });
