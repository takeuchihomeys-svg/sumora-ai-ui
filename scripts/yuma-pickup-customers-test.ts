// YUMA（テスト用会話）で、条件の違うテスト用のお客様（6人）に本番の物件資料を当て、売上サポの点・札・🌟・👑 を目で確かめる
// 2026-09-25 竹内「テストしてちゃんとできているか確認する・ちゃんと評価されているか・点数化は正確か・YUMA で徹底的にテスト・API は DeepSeek」
//
// 本番と同じ関数を通す: enrichSummariesFromPdf → buildRankMaterials → rankAndAnnotateSummaries（🌟・DeepSeek）→
//   recordPickupBatch（判定・設備・募集の条件・場所・画像の読み取り・自動の読み取り・条件の要約）
// 違う所（ローカルには Blob の鍵が無い）: @vercel/blob の put だけ scripts/yuma-blob-shim.cjs に差し替え、
//   借りた本番の資料（同じ PDF・同じ描画）の公開 URL に ?yst=<印> を付けて返す（何もアップロードしない）
// 書く物（片付けで全部消す・戻す）: property_customers（お客様A〜F）・sent_properties（送付済みの試し1行）・property_pickups・
//   image_details（?yst= の行）・property_sheet_facts（新しい行は消し、照合の答え wants_judged は元に戻す）
// お客様の名前・電話は使わない（「YUMAテスト_お客様A」）。資料は物件の資料だけ（お客様の画像は使わない）
//
// 実行: npx tsx --env-file=.env.local scripts/yuma-pickup-customers-test.ts --run [--only=A,B] --state=<json>
//       npx tsx --env-file=.env.local scripts/yuma-pickup-customers-test.ts --report --state=<json>
//       npx tsx --env-file=.env.local scripts/yuma-pickup-customers-test.ts --cleanup --state=<json>
import { createClient } from "@supabase/supabase-js";
import { register } from "node:module";
import Module from "node:module";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { enrichSummariesFromPdf, buildRankMaterials, rankAndAnnotateSummaries, loadRankConditions } from "../app/lib/pickup-rank";
import { parseRecommendMark } from "../app/lib/property-pickups";
import { sortForReview } from "../app/lib/pickup-review-order";
import { pickCustomerBest } from "../app/lib/pickup-best";
import { reasonPoints } from "../app/lib/property-brain";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const has = (k: string) => process.argv.includes(`--${k}`);
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const STATE = arg("state") ?? "yuma-pickup-customers-state.json";

// ── Blob の差し替え（本番の recordPickupBatch の `await import("@vercel/blob")` を shim に向ける）──
const SHIM = resolvePath(__dirname, "yuma-blob-shim.cjs");
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { if (s === "@vercel/blob") return { url: ${JSON.stringify(pathToFileURL(SHIM).href)}, shortCircuit: true }; return n(s, c); }`)}`);
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const origResolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) { return req === "@vercel/blob" ? SHIM : origResolve.call(this, req, ...rest); };

type Src = { id: number; site: string; summary_text: string; pdf_blob_url: string; page_image_url: string | null; agent_image_url: string | null };
type Cust = {
  key: string; theme: string; site: "itandi" | "realpro"; ids: number[];
  fields: Record<string, unknown>;
  sent?: Array<{ property_name: string; room_no: string; rent: number }>;
};

// 借りる物件（property_pickups の本番の行・2026-09-24 の itandi 18件 id 50〜67／リアプロ 12件 id 34〜45）
const ITANDI = Array.from({ length: 18 }, (_, i) => 50 + i);
const CUSTOMERS: Cust[] = [
  { key: "A", theme: "設備重視（宅配ボックス必須・浴室乾燥・独立洗面・2階以上）", site: "itandi", ids: ITANDI,
    fields: { rent_max: 70000, floor_plan: "1K", move_in_time: "11月中", desired_area: "新大阪", preferences: "宅配ボックス必須。浴室乾燥機と独立洗面台が欲しい。2階以上希望" } },
  { key: "B", theme: "駅近重視（徒歩5分・築15年）＋同じ建物を送付済み", site: "itandi", ids: [50, 51, 53, 54, 55, 57, 58, 62, 64, 67],
    fields: { rent_max: 70000, floor_plan: "1K", walk_minutes: 5, building_age: 15, desired_area: "新大阪", preferences: "駅近重視" },
    sent: [{ property_name: "エステムコート新大阪VIエキスプレイス", room_no: "710", rent: 58000 }] },
  { key: "C", theme: "家賃重視（上限6.2万・下限5万）＋初期費用を抑えたい", site: "itandi", ids: [52, 53, 55, 56, 59, 60, 61, 64, 65, 66],
    fields: { rent_max: 62000, rent_min: 50000, floor_plan: "1K", initial_cost_limit: 100000, move_in_time: "すぐ", preferences: "初期費用をできるだけ抑えたい。敷金礼金なしが希望" } },
  { key: "F", theme: "画像でしか分からない希望（WIC・対面キッチン・収納）", site: "itandi", ids: [50, 51, 54, 57, 62, 65, 67],
    fields: { rent_max: 72000, floor_plan: "1K", floor_area_min: 20, preferences: "ウォークインクローゼットが欲しい。キッチンは対面キッチンが良い。収納が多めだと嬉しい", other_requests: "バストイレ別必須" } },
  { key: "D", theme: "通勤（梅田まで20分）・オートロック", site: "realpro", ids: [34, 35, 36, 37, 38, 39, 40, 45],
    fields: { rent_max: 80000, floor_plan: "1K", commute_station: "梅田", commute_minutes: 20, preferences: "梅田まで通勤。オートロック希望" } },
  { key: "E", theme: "広げた検索（上限7.5万・25㎡・徒歩5分・築3年・大国町）＋AD の違う物件・入居10月中旬", site: "realpro", ids: Array.from({ length: 12 }, (_, i) => 34 + i),
    fields: { rent_max: 75000, floor_plan: "1K", floor_area_min: 25, walk_minutes: 5, building_age: 3, desired_area: "大国町", move_in_time: "10月中旬", preferences: "角部屋が良い" } },
];

/** 拡張 popup.js buildCustomerConditionsString の写し（🌟 に渡る条件の文） */
function conditionsString(c: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const rentMax = Number(c.rent_max ?? c.max_rent ?? 0);
  if (rentMax) parts.push("予算" + (rentMax >= 10000 ? Math.round(rentMax / 10000) + "万円" : rentMax + "円") + "以内");
  const layout = c.floor_plan ?? c.layout;
  if (layout) parts.push(layout + "希望");
  if (c.walk_minutes) parts.push("徒歩" + c.walk_minutes + "分以内");
  if (c.building_age) parts.push("築" + c.building_age + "年以内");
  if (c.floor_area_min) parts.push(c.floor_area_min + "㎡以上");
  if (c.pet === true) parts.push("ペット可"); else if (c.pet === false) parts.push("ペット不可");
  const area = c.desired_area ?? c.area;
  if (area) parts.push("エリア:" + area);
  return parts.length ? parts.join("・") : null;
}

type State = { stamp: number; startedIso: string; customers: Record<string, string>; sentIds: number[]; batches: Record<string, string>; factsSnapshot: Array<{ id: number; wants_judged: unknown; updated_at: string | null }>; factsMaxId: number; rank: Record<string, { conditions: string | null; stars: string[] }> };
const loadState = (): State | null => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) as State : null);
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 1));

async function run() {
  const only = (arg("only") ?? "").split(",").filter(Boolean);
  const list = CUSTOMERS.filter((c) => !only.length || only.includes(c.key));
  const prev = loadState();
  const stamp = prev?.stamp ?? Date.now();
  const state: State = prev ?? { stamp, startedIso: new Date().toISOString(), customers: {}, sentIds: [], batches: {}, factsSnapshot: [], factsMaxId: 0, rank: {} };
  if (!prev) {
    const { data: facts } = await sb.from("property_sheet_facts").select("id, wants_judged, updated_at").order("id");
    state.factsSnapshot = (facts ?? []) as State["factsSnapshot"];
    state.factsMaxId = Math.max(0, ...state.factsSnapshot.map((f) => f.id));
  }
  const allIds = [...new Set(list.flatMap((c) => c.ids))];
  const { data: srcRows, error: srcErr } = await sb.from("property_pickups").select("id, site, summary_text, pdf_blob_url, page_image_url, agent_image_url").in("id", allIds);
  if (srcErr) throw new Error(srcErr.message);
  const src = new Map(((srcRows ?? []) as Src[]).map((r) => [r.id, r]));
  const { recordPickupBatch } = await import("../app/lib/property-pickups-server");
  const pdfCache = new Map<number, string>();

  for (const c of list) {
    console.log(`\n==================== お客様${c.key}: ${c.theme} ====================`);
    // ① お客様（テスト用）
    let pcid = state.customers[c.key];
    if (!pcid) {
      const { data, error } = await sb.from("property_customers").insert({ customer_name: `YUMAテスト_お客様${c.key}`, ...c.fields }).select("id").single();
      if (error) throw new Error(`お客様${c.key} を作れない: ${error.message}`);
      pcid = (data as { id: string }).id;
      state.customers[c.key] = pcid;
      for (const s of c.sent ?? []) {
        const { data: sr, error: se } = await sb.from("sent_properties").insert({ property_customer_id: pcid, conversation_id: null, property_name: s.property_name, room_no: s.room_no, rent: s.rent, source: "yuma_test", delivery: "customer", channel: "recommendation", sent_at: new Date(Date.now() - 3 * 86400_000).toISOString() }).select("id").single();
        if (se) console.log("  送付済みの試しの行を入れられない:", se.message); else state.sentIds.push((sr as { id: number }).id);
      }
      saveState(state);
    }
    // ② 本番の資料（拡張が送る生の説明文＝🌟 と🧠 を外して番号を振り直す）
    const rows = c.ids.map((id) => src.get(id)).filter((r): r is Src => !!r && !!r.pdf_blob_url);
    const summaries = rows.map((r, i) => r.summary_text.replace(/\n🧠[\s\S]*$/u, "").replace(/^【\d+[^】]*】/u, `【${i + 1}】`));
    const b64 = await Promise.all(rows.map(async (r) => {
      if (!pdfCache.has(r.id)) pdfCache.set(r.id, Buffer.from(await (await fetch(r.pdf_blob_url)).arrayBuffer()).toString("base64"));
      return pdfCache.get(r.id)!;
    }));
    // ③ merge-pdfs と同じ順: 説明文の補い → 🌟 の材料 → 🌟（DeepSeek）
    // merge-pdfs と同じ: DB の条件の要約があればそれ（拡張の文は要約が無い時だけ）
    const conditions = await loadRankConditions(pcid, conditionsString(c.fields));
    const enriched = await enrichSummariesFromPdf(summaries, b64, "yuma-test");
    const materials = enriched.length > 1 ? await buildRankMaterials(b64) : null;
    const ranked = await rankAndAnnotateSummaries(enriched, conditions, materials);
    const stars = ranked.map((s, i) => ({ i, m: parseRecommendMark(s).recommended })).filter((x) => x.m > 0).sort((a, z) => z.m - a.m).map((x) => `【${x.i + 1}】${x.m === 2 ? "🌟★" : "🌟"}`);
    state.rank[c.key] = { conditions, stars };
    console.log(`  🌟 に渡した条件: ${conditions}\n  🌟 の結果: ${stars.join(" ") || "（なし）"}`);
    // ④ recordPickupBatch（本番と同じ）。Blob の put は借りた資料の URL を返す
    const batchId = `YUMA_score_${c.key}_${stamp}.pdf`;
    state.batches[c.key] = batchId;
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
      batchId, propertyCustomerId: pcid, conversationId: YUMA, customerName: `YUMAテスト_お客様${c.key}`, site: c.site,
      summaries: ranked, pdfUrls: ranked.map(() => null), pdfBase64List: b64,
    });
    console.log(`  recordPickupBatch ${Math.round((Date.now() - t0) / 1000)}秒: ${JSON.stringify(out)}`);
  }
  saveState(state);
}

type PRow = { id: number; created_at: string; batch_id: string; rank: number; property_name: string; room_no: string | null; summary_text: string; status: string; verdict: string | null; score: number | null; reason_codes: string[] | null; recommended: number; image_analysis: Record<string, unknown> | null; equipment: Record<string, unknown> | null; terms: Record<string, unknown> | null; location: Record<string, unknown> | null; image_facts: Record<string, unknown> | null; image_lines: string[] | null };

async function report() {
  const state = loadState();
  if (!state) { console.log("state が無い"); return; }
  for (const c of CUSTOMERS) {
    const batchId = state.batches[c.key];
    if (!batchId) continue;
    const { data } = await sb.from("property_pickups").select("id, created_at, batch_id, rank, property_name, room_no, summary_text, status, verdict, score, reason_codes, recommended, image_analysis, equipment, terms, location, image_facts, image_lines").eq("batch_id", batchId);
    const rows = (data ?? []) as PRow[];
    const best = pickCustomerBest(rows.map((r) => ({ ...r, image_analysis: r.image_analysis as never })));
    console.log(`\n### お客様${c.key}: ${c.theme}\n条件（🌟 に渡した文）: ${state.rank[c.key]?.conditions ?? "-"} ／ 🌟: ${state.rank[c.key]?.stars.join(" ") ?? "-"} ／ 👑: ${best ? `【${best.rank}】${best.match}点` : "なし"}`);
    console.log("| 並び | 【N】 | 物件 | 点 | 判定 | 🌟 | 👑/画像 | 札（点） |");
    console.log("|---|---|---|---|---|---|---|---|");
    sortForReview(rows).forEach((r, k) => {
      const head = r.summary_text.split("\n").slice(1, 4).join(" / ");
      const codes = (r.reason_codes ?? []).map((x) => `${x}${reasonPoints(x) ? `(${reasonPoints(x) > 0 ? "+" : ""}${reasonPoints(x)})` : ""}`).join(" ");
      const ia = r.image_analysis as { match?: number; checks?: Array<{ result: string }> } | null;
      console.log(`| ${k + 1} | ${r.rank} | ${r.property_name}${r.room_no ? " " + r.room_no : ""} ／ ${head} | ${r.score ?? "-"} | ${r.verdict ?? "-"} | ${r.recommended === 2 ? "🌟★" : r.recommended === 1 ? "🌟" : ""} | ${best?.id === r.id ? "👑" : ""}${ia?.match != null ? `${ia.match}点` : ""} | ${codes} |`);
    });
    const withImg = rows.filter((r) => r.image_facts || r.image_lines).length;
    const analyzed = rows.filter((r) => r.image_analysis).length;
    console.log(`（画像の読み取り: 資料の条件 ${rows.filter((r) => r.image_lines).length}件・間取り図の希望 ${rows.filter((r) => r.image_facts).length}件・自動の分析 ${analyzed}件／${rows.length}件）`);
    void withImg;
  }
}

async function cleanup() {
  const state = loadState();
  if (!state) { console.log("state が無い"); return; }
  const batchIds = Object.values(state.batches);
  const { data: pk } = await sb.from("property_pickups").select("id, image_analysis").in("batch_id", batchIds.length ? batchIds : ["-"]);
  const pkRows = (pk ?? []) as Array<{ id: number; image_analysis: { sheet?: { facts_id?: number } } | null }>;
  const pkIds = pkRows.map((r) => r.id);
  // property_sheet_facts: テストで新しくできた行（このテストの行から読んだ物）は消す・照合の答えを書き換えた行は元に戻す
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
  await del("sent_properties", (t) => t.delete().in("id", state.sentIds.length ? state.sentIds : [-1]).select("id"));
  await del("property_customers", (t) => t.delete().in("id", Object.values(state.customers).length ? Object.values(state.customers) : ["00000000-0000-0000-0000-000000000000"]).select("id"));
  console.log(`property_sheet_facts: 新しい行 ${factsDeleted}件 消した・照合の答え ${factsRestored}件 元に戻した`);
}

(async () => {
  if (has("run")) await run();
  if (has("report")) await report();
  if (has("cleanup")) await cleanup();
})().catch((e) => { console.error(e); process.exit(1); });
