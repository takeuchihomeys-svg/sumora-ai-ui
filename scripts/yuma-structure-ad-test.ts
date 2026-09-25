// YUMA（テスト用会話）で、AD の段の配点・構造／物件種別の読み・エレベーターの読み違いの直しを本番と同じ流れで確かめる
// 2026-09-25 任務: 条件の違うテスト用のお客様（AD の高い物件が混ざる回・木造NG・RC のみ・鉄骨以上・マンションのみ・エレベーター必須）
//
// 本番と同じ関数を通す（scripts/yuma-pickup-customers-test.ts と同じ形）:
//   loadRankConditions → enrichSummariesFromPdf → buildRankMaterials → rankAndAnnotateSummariesDetailed（🌟・DeepSeek）→
//   recordPickupBatch（判定・設備・募集の条件・場所・画像の読み取り・自動の読み取り・条件の要約）
// 違う所:
//   ① ローカルには Blob の鍵が無い → @vercel/blob の put を scripts/yuma-blob-shim.cjs に差し替え（借りた資料の公開 URL に ?yst=<印>）
//   ② 本番の資料 33件に「エレベーターなし」の資料が無い → 1件（EV の記載が無い資料）の2ページ目（元付の資料）に「エレベーターなし」の
//      1行を足した PDF をメモリの中だけで作って渡す（文字層で読む所＝判定・🌟の材料だけに効く。Blob・画像は元の資料のまま）。
//      日本語の文字を足すのに @pdf-lib/fontkit と日本語のフォントが要る（リポジトリには入れない）:
//      YST_FONTKIT=<fontkit を入れた node_modules の中のパス> YST_JP_FONT=<.ttf>（既定 C:/Windows/Fonts/HeiseiMincho_J208.ttf）
// 書く物（--cleanup で全部消す・戻す）: property_customers（テスト用のお客様・条件の要約もこの行）・property_pickups・
//   image_details（?yst= の行）・property_sheet_facts（新しい行は消し、照合の答え wants_judged は元に戻す）
// お客様の名前・電話は使わない（「YUMAテスト_構造AD_◯◯」）。資料は物件の資料だけ（お客様の画像は使わない）
//
// 実行: npx tsx --env-file=.env.local scripts/yuma-structure-ad-test.ts --run [--only=AD,EV] [--round=2] --state=<json>
//       npx tsx --env-file=.env.local scripts/yuma-structure-ad-test.ts --report [--round=2] --state=<json>
//       npx tsx --env-file=.env.local scripts/yuma-structure-ad-test.ts --usage --state=<json>
//       npx tsx --env-file=.env.local scripts/yuma-structure-ad-test.ts --cleanup --state=<json>
import { createClient } from "@supabase/supabase-js";
import { register, createRequire } from "node:module";
import Module from "node:module";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { enrichSummariesFromPdf, buildRankMaterials, rankAndAnnotateSummariesDetailed, loadRankConditions } from "../app/lib/pickup-rank";
import { parseRecommendMark } from "../app/lib/property-pickups";
import { sortForReview } from "../app/lib/pickup-review-order";
import { pickCustomerBest } from "../app/lib/pickup-best";
import { reasonPoints } from "../app/lib/property-brain";
import { extractPdfText } from "../app/lib/pdf-text";
import { parseListingEquipment } from "../app/lib/listing-equipment";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const has = (k: string) => process.argv.includes(`--${k}`);
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const STATE = arg("state") ?? "yuma-structure-ad-state.json";

// ── Blob の差し替え（本番の recordPickupBatch の `await import("@vercel/blob")` を shim に向ける）──
const SHIM = resolvePath(__dirname, "yuma-blob-shim.cjs");
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { if (s === "@vercel/blob") return { url: ${JSON.stringify(pathToFileURL(SHIM).href)}, shortCircuit: true }; return n(s, c); }`)}`);
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const origResolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) { return req === "@vercel/blob" ? SHIM : origResolve.call(this, req, ...rest); };

type Src = { id: number; site: string; summary_text: string; pdf_blob_url: string; page_image_url: string | null; agent_image_url: string | null };
type Cust = { key: string; theme: string; site: "itandi" | "realpro"; ids: number[]; fields: Record<string, unknown>; edits?: Record<number, string>; expect: string };

// 借りる物件（property_pickups の本番の行）。同じ建物の部屋は1回に1つだけ（同じ建物の間引きで落ちないように）
//   リアプロ 1LDK 3件: #1 木造アパート 3階 AD2.5 敷礼0／#2 RC マンション 1階 AD1／#3 鉄骨マンション 3階 AD 記載なし
//   itandi 1K: #51 AD2 徒歩5 1階／#53 AD1 徒歩1／#54 AD1 徒歩4／#57 AD0 1R／#58 AD2.5 徒歩8／#62 AD0／#64 AD1 徒歩7／#67 AD1 徒歩5
const TRIO = [1, 2, 3];
const CUSTOMERS: Cust[] = [
  { key: "AD", theme: "AD の高い物件が混ざる（条件が合う AD 1〜2ヶ月／徒歩が合わない AD 2.5ヶ月）", site: "itandi", ids: [51, 53, 54, 57, 58, 62, 64, 67],
    fields: { rent_max: 70000, floor_plan: "1K", walk_minutes: 5, desired_area: "新大阪" },
    expect: "#58（AD2.5・徒歩8分＝希望の1.6倍）は保留で AD 0点・最上位にしない。条件が合う物件の中では #51（AD2）が AD1 より上" },
  { key: "WOOD", theme: "木造NG", site: "realpro", ids: TRIO, fields: { rent_max: 92000, floor_plan: "1LDK", ng_points: "木造NG" },
    expect: "#1 木造（AD2.5）は保留・🌟なし・最上位にしない。#2 RC・#3 鉄骨 は ○" },
  { key: "RC", theme: "RC のみ（鉄筋コンクリート造のみ）", site: "realpro", ids: TRIO, fields: { rent_max: 92000, floor_plan: "1LDK", preferences: "鉄筋コンクリート造のみ" },
    expect: "#2 RC ○(+3)／#3 鉄骨 △(0点・一段下)／#1 木造 ×(保留)" },
  { key: "STEEL", theme: "鉄骨以上（構造の欄「鉄骨造 RC造 SRC造」）", site: "realpro", ids: TRIO, fields: { rent_max: 92000, floor_plan: "1LDK", structure_types: "鉄骨造 RC造 SRC造" },
    expect: "#2 RC ○・#3 鉄骨 ○／#1 木造 ×(保留)" },
  { key: "MANSION", theme: "マンションのみ", site: "realpro", ids: TRIO, fields: { rent_max: 92000, floor_plan: "1LDK", preferences: "マンションのみ" },
    expect: "#1 アパート ×(保留)・#2 #3 マンション ○" },
  { key: "EV", theme: "エレベーター必須（#55 の資料に「エレベーターなし」を足す）", site: "itandi", ids: [53, 54, 55, 61, 62, 66, 67],
    fields: { rent_max: 70000, floor_plan: "1K", preferences: "エレベーター必須" }, edits: { 55: "エレベーターなし" },
    expect: "#55（AD2・敷礼0・7階・エレベーターなし）は × で保留・必須なので上限20点・🌟なし。EV あり（#53 #61 #62 #67）は ○" },
];

/** 拡張 popup.js buildCustomerConditionsString の写し（DB の要約が無い時だけ🌟 に渡る） */
function conditionsString(c: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const rentMax = Number(c.rent_max ?? 0);
  if (rentMax) parts.push("予算" + Math.round(rentMax / 10000) + "万円以内");
  if (c.floor_plan) parts.push(c.floor_plan + "希望");
  if (c.walk_minutes) parts.push("徒歩" + c.walk_minutes + "分以内");
  if (c.desired_area) parts.push("エリア:" + c.desired_area);
  return parts.length ? parts.join("・") : null;
}

/** 資料の2ページ目（元付の資料・無ければ1ページ目）の下に1行足した PDF（メモリの中だけ） */
async function addLineToPdf(b64: string, line: string): Promise<string> {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const req = createRequire(__filename);
  const fk = req(process.env.YST_FONTKIT ?? "@pdf-lib/fontkit");
  const doc = await PDFDocument.load(Buffer.from(b64, "base64"));
  doc.registerFontkit(fk.default ?? fk);
  const font = await doc.embedFont(readFileSync(process.env.YST_JP_FONT ?? "C:/Windows/Fonts/HeiseiMincho_J208.ttf"), { subset: true });
  const pages = doc.getPages();
  const p = pages[Math.min(1, pages.length - 1)];
  p.drawText(line, { x: 36, y: 24, size: 9, font, color: rgb(0, 0, 0) });
  return Buffer.from(await doc.save()).toString("base64");
}

type State = { stamp: number; startedIso: string; customers: Record<string, string>; batches: Record<string, string>; factsSnapshot: Array<{ id: number; wants_judged: unknown; updated_at: string | null }>; factsMaxId: number; rank: Record<string, { conditions: string | null; stars: string[]; status: string; materials: Array<string | null> }> };
const loadState = (): State | null => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) as State : null);
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 1));

async function run() {
  const only = (arg("only") ?? "").split(",").filter(Boolean);
  const round = arg("round") ?? "1";
  const list = CUSTOMERS.filter((c) => !only.length || only.includes(c.key));
  const prev = loadState();
  const stamp = prev?.stamp ?? Date.now();
  const state: State = prev ?? { stamp, startedIso: new Date().toISOString(), customers: {}, batches: {}, factsSnapshot: [], factsMaxId: 0, rank: {} };
  if (!prev) {
    const { data: facts } = await sb.from("property_sheet_facts").select("id, wants_judged, updated_at").order("id");
    state.factsSnapshot = (facts ?? []) as State["factsSnapshot"];
    state.factsMaxId = Math.max(0, ...state.factsSnapshot.map((f) => f.id));
    saveState(state);
  }
  const allIds = [...new Set(list.flatMap((c) => c.ids))];
  const { data: srcRows, error: srcErr } = await sb.from("property_pickups").select("id, site, summary_text, pdf_blob_url, page_image_url, agent_image_url").in("id", allIds);
  if (srcErr) throw new Error(srcErr.message);
  const src = new Map(((srcRows ?? []) as Src[]).map((r) => [r.id, r]));
  const { recordPickupBatch } = await import("../app/lib/property-pickups-server");
  const pdfCache = new Map<number, string>();

  for (const c of list) {
    console.log(`\n==================== ${c.key}: ${c.theme} ====================`);
    let pcid = state.customers[c.key];
    if (!pcid) {
      const { data, error } = await sb.from("property_customers").insert({ customer_name: `YUMAテスト_構造AD_${c.key}`, status: "property_search", ...c.fields }).select("id").single();
      if (error) throw new Error(`${c.key} を作れない: ${error.message}`);
      pcid = (data as { id: string }).id;
      state.customers[c.key] = pcid;
      saveState(state);
    }
    const rows = c.ids.map((id) => src.get(id)).filter((r): r is Src => !!r && !!r.pdf_blob_url);
    const summaries = rows.map((r, i) => r.summary_text.replace(/\n🧠[\s\S]*$/u, "").replace(/^【\d+[^】]*】/u, `【${i + 1}】`));
    const b64 = await Promise.all(rows.map(async (r) => {
      if (!pdfCache.has(r.id)) pdfCache.set(r.id, Buffer.from(await (await fetch(r.pdf_blob_url)).arrayBuffer()).toString("base64"));
      let b = pdfCache.get(r.id)!;
      const edit = c.edits?.[r.id];
      if (edit) {
        b = await addLineToPdf(b, edit);
        const t = await extractPdfText(b, { maxPages: 2, maxChars: 8000 });
        const eq = parseListingEquipment(t.text);
        console.log(`  #${r.id} の資料に「${edit}」を足した → 文字層に ${t.text.includes(edit) ? "あり" : "なし"}・エレベーターの読み ${eq.items.elevator.status}（${eq.items.elevator.evidence ?? "-"}）`);
      }
      return b;
    }));
    const conditions = await loadRankConditions(pcid, conditionsString(c.fields));
    const enriched = await enrichSummariesFromPdf(summaries, b64, "yuma-structure-ad");
    const materials = enriched.length > 1 ? await buildRankMaterials(b64) : [];
    const outcome = await rankAndAnnotateSummariesDetailed(enriched, conditions, materials);
    const ranked = outcome.summaries;
    const stars = ranked.map((s, i) => ({ i, m: parseRecommendMark(s).recommended })).filter((x) => x.m > 0).sort((a, z) => z.m - a.m).map((x) => `#${rows[x.i].id}${x.m === 2 ? "🌟★" : "🌟"}`);
    state.rank[`${c.key}#${round}`] = { conditions, stars, status: outcome.status, materials: materials.map((m, i) => (m ? `#${rows[i].id} ${m}` : null)) };
    console.log(`  🌟 に渡した条件: ${conditions}\n  🌟 の結果(${outcome.status}): ${stars.join(" ") || "（なし）"}`);
    materials.forEach((m, i) => console.log(`    資料 #${rows[i].id}: ${m ?? "-"}`));
    const batchId = `YUMA_sa${round}_${c.key}_${stamp}.pdf`;
    state.batches[`${c.key}#${round}`] = batchId;
    saveState(state);
    const base = `pickups/${batchId.replace(/\.pdf$/i, "")}_`;
    (globalThis as Record<string, unknown>).__YST_PUT = (pathname: string) => {
      if (!pathname.startsWith(base)) return null;
      const m = pathname.slice(base.length).match(/^(\d+)_\d+(?:_(p1|p2))?\.(pdf|png)$/);
      if (!m) return null;
      const r = rows[Number(m[1]) - 1];
      const u = m[2] === "p1" ? r?.page_image_url : m[2] === "p2" ? r?.agent_image_url : r?.pdf_blob_url;
      return u ? `${u}${u.includes("?") ? "&" : "?"}yst=${stamp}` : null;
    };
    const t0 = Date.now();
    const out = await recordPickupBatch({
      batchId, propertyCustomerId: pcid, conversationId: YUMA, customerName: `YUMAテスト_構造AD_${c.key}`, site: c.site,
      summaries: ranked, pdfUrls: ranked.map(() => null), pdfBase64List: b64,
    });
    console.log(`  recordPickupBatch ${Math.round((Date.now() - t0) / 1000)}秒: ${JSON.stringify(out)}`);
  }
  saveState(state);
}

type PRow = { id: number; created_at: string; batch_id: string; rank: number; property_name: string; room_no: string | null; summary_text: string; status: string; verdict: string | null; score: number | null; reason_codes: string[] | null; recommended: number; image_analysis: Record<string, unknown> | null };

async function report() {
  const state = loadState();
  if (!state) { console.log("state が無い"); return; }
  const round = arg("round") ?? "1";
  for (const c of CUSTOMERS) {
    const batchId = state.batches[`${c.key}#${round}`];
    if (!batchId) continue;
    const { data } = await sb.from("property_pickups").select("id, created_at, batch_id, rank, property_name, room_no, summary_text, status, verdict, score, reason_codes, recommended, image_analysis").eq("batch_id", batchId);
    const rows = (data ?? []) as PRow[];
    const best = pickCustomerBest(rows.map((r) => ({ ...r, image_analysis: r.image_analysis as never })));
    const srcId = (rank: number) => c.ids[rank - 1];
    const rk = state.rank[`${c.key}#${round}`];
    console.log(`\n### ${c.key}: ${c.theme}\n期待: ${c.expect}\n🌟 に渡した条件: ${(rk?.conditions ?? "-").replace(/\n/g, " ／ ")}\n🌟(${rk?.status ?? "-"}): ${rk?.stars.join(" ") ?? "-"} ／ 👑: ${best ? `#${srcId(best.rank)} ${best.match}点` : "なし（画像で分析の点が付いた物件なし）"}`);
    for (const m of rk?.materials ?? []) if (m) console.log(`  資料: ${m}`);
    console.log("| 並び | 資料 | 物件 | 点 | 判定 | 🌟 | 👑 | 札（点） |");
    console.log("|---|---|---|---|---|---|---|---|");
    sortForReview(rows).forEach((r, k) => {
      const head = r.summary_text.split("\n").slice(1, 3).join(" / ").replace(/\|/g, "／");
      const codes = (r.reason_codes ?? []).map((x) => `${x}${reasonPoints(x) ? `(${reasonPoints(x) > 0 ? "+" : ""}${reasonPoints(x)})` : ""}`).join(" ");
      console.log(`| ${k + 1} | #${srcId(r.rank)} | ${r.property_name}${r.room_no ? " " + r.room_no : ""} ／ ${head} | ${r.score ?? "-"} | ${r.verdict ?? "-"} | ${r.recommended === 2 ? "🌟★" : r.recommended === 1 ? "🌟" : ""} | ${best?.id === r.id ? "👑" : ""} | ${codes} |`);
    });
  }
}

async function usage() {
  const state = loadState();
  if (!state) { console.log("state が無い"); return; }
  const { data, error } = await sb.from("llm_usage_logs").select("created_at, route, model, action, status, error_type, input_uncached, cache_read, output_tokens, duration_ms, env, conversation_id").gte("created_at", state.startedIso).eq("env", "local").order("created_at").limit(2000);
  if (error) throw new Error(error.message);
  type U = { route: string | null; model: string; action: string | null; status: number; error_type: string | null; input_uncached: number | null; cache_read: number | null; output_tokens: number | null; duration_ms: number | null };
  const rows = (data ?? []) as U[];
  const agg = new Map<string, { n: number; fail: number; miss: number; hit: number; out: number; ms: number[] }>();
  for (const r of rows) {
    const k = `${r.action ?? r.route ?? "-"} | ${r.model}`;
    const a = agg.get(k) ?? { n: 0, fail: 0, miss: 0, hit: 0, out: 0, ms: [] };
    a.n++; if (r.status !== 200 || r.error_type) a.fail++;
    a.miss += r.input_uncached ?? 0; a.hit += r.cache_read ?? 0; a.out += r.output_tokens ?? 0; if (r.duration_ms) a.ms.push(r.duration_ms);
    agg.set(k, a);
  }
  const YEN = 150;
  let total = 0;
  console.log(`\nllm_usage_logs（env=local・${state.startedIso} 以降）${rows.length}行 ／ Claude の行: ${rows.filter((r) => /claude|haiku|sonnet|opus/i.test(r.model)).length}`);
  console.log("| action | model | 回数 | 失敗 | 入力(外れ) | 命中 | 命中率 | 出力 | 中央 | 費用(円) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, a] of agg) {
    const [action, model] = k.split(" | ");
    const yen = /deepseek/i.test(model) ? (a.miss * 0.28 + a.hit * 0.028 + a.out * 0.42) / 1e6 * YEN : NaN;
    if (!Number.isNaN(yen)) total += yen;
    const med = a.ms.sort((x, y) => x - y)[Math.floor(a.ms.length / 2)] ?? 0;
    console.log(`| ${action} | ${model} | ${a.n} | ${a.fail} | ${a.miss} | ${a.hit} | ${a.miss + a.hit ? Math.round((a.hit / (a.miss + a.hit)) * 100) : 0}% | ${a.out} | ${(med / 1000).toFixed(1)}秒 | ${Number.isNaN(yen) ? "?" : yen.toFixed(2)} |`);
  }
  console.log(`合計 約${total.toFixed(1)}円（DeepSeek 公式価格 $0.28/M 外れ・$0.028/M 命中・$0.42/M 出力・1ドル${YEN}円）`);
}

async function cleanup() {
  const state = loadState();
  if (!state) { console.log("state が無い"); return; }
  const batchIds = Object.values(state.batches);
  const { data: pk } = await sb.from("property_pickups").select("id").in("batch_id", batchIds.length ? batchIds : ["-"]);
  const pkIds = ((pk ?? []) as Array<{ id: number }>).map((r) => r.id);
  const { data: facts } = await sb.from("property_sheet_facts").select("id, wants_judged, updated_at, source_pickup_id").order("id");
  const snap = new Map(state.factsSnapshot.map((f) => [f.id, f]));
  let factsDeleted = 0, factsRestored = 0;
  for (const f of (facts ?? []) as Array<{ id: number; wants_judged: unknown; updated_at: string | null; source_pickup_id: number | null }>) {
    const s = snap.get(f.id);
    if (!s) {
      if (f.id > state.factsMaxId && f.source_pickup_id != null && pkIds.includes(f.source_pickup_id)) {
        const { error } = await sb.from("property_sheet_facts").delete().eq("id", f.id);
        if (!error) factsDeleted++; else console.log("facts 消せない", f.id, error.message);
      }
    } else if (s.updated_at !== f.updated_at && f.updated_at && f.updated_at >= state.startedIso) {
      const { error } = await sb.from("property_sheet_facts").update({ wants_judged: s.wants_judged, updated_at: s.updated_at }).eq("id", f.id);
      if (!error) factsRestored++; else console.log("facts 戻せない", f.id, error.message);
    }
  }
  const del = async (table: string, q: (x: ReturnType<typeof sb.from>) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) => {
    const r = await q(sb.from(table));
    console.log(`${table}: ${r.error ? "失敗 " + r.error.message : `${(r.data ?? []).length}件 消した`}`);
  };
  await del("property_pickups", (t) => t.delete().in("batch_id", batchIds.length ? batchIds : ["-"]).select("id"));
  await del("image_details", (t) => t.delete().like("image_url", `%yst=${state.stamp}%`).select("image_url"));
  const cids = Object.values(state.customers);
  if (cids.length) await del("property_customers", (t) => t.delete().in("id", cids).select("id"));
  console.log(`property_sheet_facts: 新しい行 ${factsDeleted}件 消した・照合の答え ${factsRestored}件 元に戻した`);
}

(async () => {
  if (has("run")) await run();
  if (has("report")) await report();
  if (has("usage")) await usage();
  if (has("cleanup")) await cleanup();
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
