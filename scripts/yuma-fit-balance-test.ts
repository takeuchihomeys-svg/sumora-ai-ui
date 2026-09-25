// YUMA（テスト用会話）で「案B」（お客様が書いた条件だけ重く・全部合う・AD の段）と「一番オススメ＝点の1位（👑）」と
// 「カードの項目ごとの点」を、本番と同じ流れで確かめる。
// 2026-09-25 竹内「お客さんの希望に合っていたら点数加点する重み付け・AD のように」「全部の条件当てはまっていたらさらに加点」
//   「AD 1未満は点数低く」「一番オススメが点の低い物件に付いていた」「カードの項目に各項目の点数」
//
// 流れ（本番の merge-pdfs → recordPickupBatch → 自動の読み取り → まとめ と同じ関数）:
//   enrichSummariesFromPdf → buildRankMaterials → loadRankConditions → rankAndAnnotateSummariesDetailed（🌟・DeepSeek）
//   → recordPickupBatch（判定・設備・募集の条件・場所・画像の読み取り・自動の読み取り・条件の要約）
//   → claimCompleteGroup ＋ finishCompleteGroup（拡張の「完了」と同じまとめ・👑 の best_id）
// 画面の値: 詳細 API（app/api/property-pickups/route.ts buildDetail）と同じ純関数で作る
//   （customerImageNeed → bestBasisFor → pickCustomerBest（まとめの best_id を preferId）→ roundBestId → sortForReview → buildPickupCardView）
// 違う所: @vercel/blob の put だけ scripts/yuma-blob-shim.cjs に差し替え（借りた本番の資料の URL に ?yst=<印> を付けて返す・何も置かない）
// 書く物（--cleanup で全部消す・戻す）: property_customers（YUMAテスト_お客様A〜F）・property_pickups・property_pickup_completions・
//   image_details（?yst= の行）・property_sheet_facts（新しい行は消し、照合の答えは元に戻す）
// お客様の名前・電話は使わない。LLM は DeepSeek だけ（pickup-rank・property-image-read・pickup-auto-analyze・condition-summary）
//
// 実行: npx tsx --env-file=.env.local scripts/yuma-fit-balance-test.ts --run [--only=A,B] [--state=<json>]
//       npx tsx --env-file=.env.local scripts/yuma-fit-balance-test.ts --report [--state=<json>]
//       npx tsx --env-file=.env.local scripts/yuma-fit-balance-test.ts --cleanup [--state=<json>]
import { createClient } from "@supabase/supabase-js";
import { register } from "node:module";
import Module from "node:module";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { enrichSummariesFromPdf, buildRankMaterials, rankAndAnnotateSummariesDetailed, loadRankConditions } from "../app/lib/pickup-rank";
import { parseRecommendMark } from "../app/lib/property-pickups";
import { sortForReview } from "../app/lib/pickup-review-order";
import { pickCustomerBest, roundBestId, customerImageNeed, bestBasisFor } from "../app/lib/pickup-best";
import { buildPickupCardView, groupPickupRounds } from "../app/lib/pickup-card-view";
import { BASE_SCORE, SCORE_MAX, summarizeFit } from "../app/lib/property-brain";
import { COMPLETE_BEST_WINDOW_HOURS } from "../app/lib/pickup-complete";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const has = (k: string) => process.argv.includes(`--${k}`);
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const STATE = arg("state") ?? "yuma-fit-balance-state.json";

// ── Blob の差し替え（本番の recordPickupBatch の `await import("@vercel/blob")` を shim に向ける）──
const SHIM = resolvePath(__dirname, "yuma-blob-shim.cjs");
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { if (s === "@vercel/blob") return { url: ${JSON.stringify(pathToFileURL(SHIM).href)}, shortCircuit: true }; return n(s, c); }`)}`);
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const origResolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) { return req === "@vercel/blob" ? SHIM : origResolve.call(this, req, ...rest); };

type Src = { id: number; site: string; summary_text: string; pdf_blob_url: string; page_image_url: string | null; agent_image_url: string | null };
type Batch = { site: "itandi" | "realpro"; ids: number[] };
type Cust = { key: string; theme: string; batches: Batch[]; fields: Record<string, unknown>;
  /** 会話（YUMA）を結び付けない＝画像の希望は条件欄だけ（YUMA の会話の「バストイレ別・収納」を拾わない）→ 判定の点で 👑 を決めるお客様を確かめる */
  noConv?: boolean };

// 借りる物件（property_pickups の本番の行）: リアプロ 34〜45（難波・築1〜6年・AD 1.5〜2ヶ月・礼金0/1）／
//   itandi 50〜67（新大阪・築9〜19年・徒歩1〜9分・5.8〜6.7万・AD なし/0.5/1/2/2.5）／野口さんの回 358・359・369・370（難波・8.3〜9.3万）
const CUSTOMERS: Cust[] = [
  { key: "A", theme: "築浅（自由文）・リアプロと itandi の2回をまとめる", batches: [
      { site: "realpro", ids: [34, 36, 37, 40, 45, 370, 369] },
      { site: "itandi", ids: [51, 54, 61, 62, 66, 67] },
    ],
    fields: { rent_max: 80000, floor_plan: "1K", preferences: "築浅がいいです。築5年以内が理想" } },
  { key: "B", theme: "駅近（自由文・徒歩の欄は空）＋AD なし／1ヶ月未満が混ざる", batches: [
      { site: "itandi", ids: [50, 51, 53, 54, 55, 57, 58, 60, 62, 65, 67] },
    ],
    fields: { rent_max: 70000, floor_plan: "1K", preferences: "駅近希望です（駅から徒歩5分以内）" } },
  { key: "C", theme: "家賃を低くしたい（上限6.5万）", batches: [
      { site: "itandi", ids: [51, 52, 53, 55, 56, 59, 60, 61, 63, 64, 66, 67] },
    ],
    fields: { rent_max: 65000, floor_plan: "1K", preferences: "家賃はできるだけ安く抑えたいです" }, noConv: true },
  { key: "D", theme: "初期費用を抑えたい（敷金礼金なし）・AD 1.5 と 2 の比べ", batches: [
      { site: "realpro", ids: [34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45] },
    ],
    fields: { rent_max: 80000, floor_plan: "1K", preferences: "初期費用を抑えたいので敷金礼金なしが希望です" }, noConv: true },
  { key: "E", theme: "必須の設備（宅配ボックス必須・オートロック必須・浴室乾燥はできれば）", batches: [
      { site: "itandi", ids: [50, 51, 52, 53, 54, 55, 57, 59, 61, 62, 64, 67] },
    ],
    fields: { rent_max: 70000, floor_plan: "1K", preferences: "宅配ボックス必須。オートロック必須。浴室乾燥機はできればあると嬉しい" } },
  // C は借りた物件が全部 上限の 0.97〜1.08 倍（管理費込み）で「家賃を低く」の段に当たらなかった → 上限を上げて段を確かめる
  { key: "C2", theme: "家賃を低くしたい（上限7.5万・段 0.8／0.9／0.95 を確かめる）", batches: [
      { site: "itandi", ids: [50, 51, 52, 53, 55, 56, 59, 61, 63, 64, 66, 67] },
    ],
    fields: { rent_max: 75000, floor_plan: "1K", preferences: "家賃はできるだけ安く抑えたいです" }, noConv: true },
  { key: "G", theme: "築浅は必須（×1.3）・駅近はできれば（×0.6）・リアプロと itandi の2回をまとめる", batches: [
      { site: "realpro", ids: [34, 36, 37, 45, 370] },
      { site: "itandi", ids: [51, 54, 61, 67, 53] },
    ],
    fields: { rent_max: 85000, floor_plan: "1K", preferences: "築浅は必須です。できれば駅近" }, noConv: true },
  { key: "F", theme: "条件を書いていない（予算と間取りだけ）", batches: [
      { site: "realpro", ids: [358, 359, 369, 370, 34, 36, 39, 45] },
    ],
    fields: { rent_max: 95000 } },
];

/** 拡張 popup.js buildCustomerConditionsString の写し（🌟 に渡る条件の文・DB の要約が無い時だけ使われる） */
function conditionsString(c: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const rentMax = Number(c.rent_max ?? c.max_rent ?? 0);
  if (rentMax) parts.push("予算" + (rentMax >= 10000 ? Math.round(rentMax / 10000) + "万円" : rentMax + "円") + "以内");
  const layout = c.floor_plan ?? c.layout;
  if (layout) parts.push(layout + "希望");
  if (c.walk_minutes) parts.push("徒歩" + c.walk_minutes + "分以内");
  if (c.building_age) parts.push("築" + c.building_age + "年以内");
  const area = c.desired_area ?? c.area;
  if (area) parts.push("エリア:" + area);
  return parts.length ? parts.join("・") : null;
}

type State = {
  stamp: number; startedIso: string; customers: Record<string, string>; batches: Record<string, string[]>; groups: Record<string, string | null>;
  factsSnapshot: Array<{ id: number; wants_judged: unknown; updated_at: string | null }>; factsMaxId: number;
  rank: Record<string, Array<{ conditions: string | null; stars: string[]; status: string }>>;
  record: Record<string, unknown[]>; finish: Record<string, unknown>;
};
const loadState = (): State | null => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) as State : null);
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 1));

async function run() {
  const only = (arg("only") ?? "").split(",").filter(Boolean);
  const list = CUSTOMERS.filter((c) => !only.length || only.includes(c.key));
  const prev = loadState();
  const stamp = prev?.stamp ?? Date.now();
  const state: State = prev ?? { stamp, startedIso: new Date().toISOString(), customers: {}, batches: {}, groups: {}, factsSnapshot: [], factsMaxId: 0, rank: {}, record: {}, finish: {} };
  if (!prev) {
    const { data: facts } = await sb.from("property_sheet_facts").select("id, wants_judged, updated_at").order("id");
    state.factsSnapshot = (facts ?? []) as State["factsSnapshot"];
    state.factsMaxId = Math.max(0, ...state.factsSnapshot.map((f) => f.id));
    saveState(state);
  }
  const allIds = [...new Set(list.flatMap((c) => c.batches.flatMap((b) => b.ids)))];
  const { data: srcRows, error: srcErr } = await sb.from("property_pickups").select("id, site, summary_text, pdf_blob_url, page_image_url, agent_image_url").in("id", allIds);
  if (srcErr) throw new Error(srcErr.message);
  const src = new Map(((srcRows ?? []) as Src[]).map((r) => [r.id, r]));
  const { recordPickupBatch } = await import("../app/lib/property-pickups-server");
  const { claimCompleteGroup, finishCompleteGroup } = await import("../app/lib/pickup-complete-server");
  const pdfCache = new Map<number, string>();

  for (const c of list) {
    console.log(`\n==================== お客様${c.key}: ${c.theme} ====================`);
    let pcid = state.customers[c.key];
    if (!pcid) {
      const { data, error } = await sb.from("property_customers").insert({ customer_name: `YUMAテスト_お客様${c.key}`, ...c.fields }).select("id").single();
      if (error) throw new Error(`お客様${c.key} を作れない: ${error.message}`);
      pcid = (data as { id: string }).id;
      state.customers[c.key] = pcid;
      saveState(state);
    }
    // 同じお客様でもう一度回す時は回を足す（片付けは state.batches の全部を消す・表は一番新しいまとめを読む）
    state.batches[c.key] = state.batches[c.key] ?? [];
    state.rank[c.key] = [];
    state.record[c.key] = [];
    for (const [bi, b] of c.batches.entries()) {
      const rows = b.ids.map((id) => src.get(id)).filter((r): r is Src => !!r && !!r.pdf_blob_url);
      // 拡張が送る生の説明文（🌟 と 🧠 を外して番号を振り直す）
      const summaries = rows.map((r, i) => r.summary_text.replace(/\n\s*\n?🧠[\s\S]*$/u, "").replace(/^【\d+[^】]*】/u, `【${i + 1}】`));
      const b64 = await Promise.all(rows.map(async (r) => {
        if (!pdfCache.has(r.id)) pdfCache.set(r.id, Buffer.from(await (await fetch(r.pdf_blob_url)).arrayBuffer()).toString("base64"));
        return pdfCache.get(r.id)!;
      }));
      // merge-pdfs と同じ順: 説明文の補い → 🌟 の材料 → 条件（DB の要約が先）→ 🌟（DeepSeek）
      const enriched = await enrichSummariesFromPdf(summaries, b64, "yuma-test");
      const materials = enriched.length > 1 ? await buildRankMaterials(b64) : null;
      const conditions = enriched.length > 1 ? await loadRankConditions(pcid, conditionsString(c.fields)) : conditionsString(c.fields);
      const outcome = await rankAndAnnotateSummariesDetailed(enriched, conditions, materials);
      const ranked = outcome.summaries;
      const stars = ranked.map((s, i) => ({ i, m: parseRecommendMark(s).recommended })).filter((x) => x.m > 0).sort((a, z) => z.m - a.m).map((x) => `【${x.i + 1}】${x.m === 2 ? "🌟★" : "🌟"}`);
      state.rank[c.key].push({ conditions, stars, status: outcome.status });
      console.log(`  回${bi + 1}（${b.site}・${rows.length}件）🌟 の条件: ${conditions}\n    🌟: ${stars.join(" ") || "（なし）"}（${outcome.status}）`);
      const batchId = `YUMA_fit_${c.key}_${bi + 1}_${stamp}_${state.batches[c.key].length + 1}.pdf`;
      state.batches[c.key].push(batchId);
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
        batchId, propertyCustomerId: pcid, conversationId: c.noConv ? null : YUMA, customerName: `YUMAテスト_お客様${c.key}`, site: b.site,
        summaries: ranked, pdfUrls: ranked.map(() => null), pdfBase64List: b64,
      });
      state.record[c.key].push(out);
      saveState(state);
      console.log(`    recordPickupBatch ${Math.round((Date.now() - t0) / 1000)}秒: ${JSON.stringify(out)}`);
    }
    // まとめ（拡張の「完了」と同じ）
    const claim = await claimCompleteGroup(pcid, { trigger: "yuma-test", mode: "brain", requestedBy: "yuma-test" });
    state.groups[c.key] = claim.groupId;
    saveState(state);
    if (claim.ok && claim.groupId && claim.claimedIds.length) {
      const t1 = Date.now();
      const f = await finishCompleteGroup({ groupId: claim.groupId, claimedIds: claim.claimedIds, propertyCustomerId: pcid, conversationId: claim.conversationId, deadlineAt: Date.now() + 200_000 });
      state.finish[c.key] = { claimed: claim.claimedIds.length, analyzed: f.analyzed, level: f.analyzeLevel, best: f.ranking?.bestId ?? null, basis: f.ranking?.bestBasis ?? null, error: f.error, ms: Date.now() - t1 };
      console.log(`  まとめ: ${JSON.stringify(state.finish[c.key])}`);
    } else {
      console.log(`  まとめられない: ${JSON.stringify(claim)}`);
    }
    saveState(state);
  }
}

type PRow = {
  id: number; created_at: string; batch_id: string; site: string | null; rank: number; property_name: string; room_no: string | null; summary_text: string; status: string;
  verdict: string | null; score: number | null; reason_codes: string[] | null; reasons_ja: string[] | null; recommended: number; ad_yen: number | null;
  image_analysis: Record<string, unknown> | null; equipment: Record<string, unknown> | null; terms: Record<string, unknown> | null; location: Record<string, unknown> | null;
  image_lines: string[] | null; complete_group_id: string | null; complete_rank: number | null;
};

const AD_LOW = /^(?:AD_NONE|AD_UNDER_1M)$/;
const adCodes = (codes: string[]) => codes.filter((c) => /^AD_|^PROFIT_NEGATIVE$/.test(c));
/** AD の段の数（比べ用）: なし 0／1ヶ月未満 1／不明 2／1ヶ月 3／1.5 4／2 5／2.5〜 6 */
function adTier(codes: string[]): number {
  if (codes.includes("AD_NONE")) return 0;
  if (codes.includes("AD_UNDER_1M")) return 1;
  if (codes.some((c) => /^AD_(?:2_5M|VERY_HIGH)/.test(c))) return 6;
  if (codes.some((c) => /^AD_HIGH/.test(c))) return 5;
  if (codes.some((c) => /^AD_1_5M/.test(c))) return 4;
  if (codes.some((c) => /^AD_1M/.test(c))) return 3;
  return 2;
}

async function report() {
  const state = loadState();
  if (!state) { console.log("state が無い"); return; }
  const problems: string[] = [];
  for (const c of CUSTOMERS) {
    const pcid = state.customers[c.key];
    const bids = state.batches[c.key] ?? [];
    if (!pcid || !bids.length) continue;
    const { data } = await sb.from("property_pickups")
      .select("id, created_at, batch_id, site, rank, property_name, room_no, summary_text, status, verdict, score, reason_codes, reasons_ja, recommended, ad_yen, image_analysis, equipment, terms, location, image_lines, complete_group_id, complete_rank")
      .eq("property_customer_id", pcid).order("created_at", { ascending: false }).limit(300);
    const rows = (data ?? []) as PRow[];
    const { data: pc } = await sb.from("property_customers").select("preferences, ng_points, other_requests, additional_conditions").eq("id", pcid).maybeSingle();
    // 詳細 API（buildDetail）と同じ: 画像で分析が要るか → 👑 の決め方 → まとめの best_id → 全体の 👑
    const need = customerImageNeed(rows, (pc ?? null) as Parameters<typeof customerImageNeed>[1]);
    const basis = bestBasisFor(need);
    const gid = rows[0]?.complete_group_id ?? null;
    let preferId: number | null = null;
    let compNote = "まとめなし";
    if (gid) {
      const { data: comp } = await sb.from("property_pickup_completions").select("status, best_id, best_basis, finished_at, result").eq("group_id", gid).maybeSingle();
      const cp = comp as { status: string | null; best_id: number | null; best_basis: string | null; finished_at: string | null; result: { basis_rule?: string } | null } | null;
      const finMs = cp?.finished_at ? Date.parse(cp.finished_at) : NaN;
      const groupRows0 = rows.filter((r) => r.complete_group_id === gid);
      const reanalyzed = Number.isFinite(finMs) && groupRows0.some((r) => { const at = Date.parse(String((r.image_analysis as { analyzed_at?: unknown } | null)?.analyzed_at ?? "")); return Number.isFinite(at) && at > finMs; });
      preferId = cp?.status === "done" && cp.best_id != null && !reanalyzed && cp.result?.basis_rule === basis ? Number(cp.best_id) : null;
      compNote = `まとめ ${cp?.status}・best_id ${cp?.best_id}（${cp?.best_basis}）`;
    }
    const groupRows = gid ? rows.filter((r) => r.complete_group_id === gid) : rows;
    const best = pickCustomerBest(groupRows, { windowHours: gid ? COMPLETE_BEST_WINDOW_HOURS : undefined, basis, preferId });
    // 画面の回（まとめの回ごと）: 回の 👑（roundBestId）→ sortForReview の先頭
    const byBatch = new Map<string, PRow[]>();
    for (const r of rows) byBatch.set(r.batch_id, [...(byBatch.get(r.batch_id) ?? []), r]);
    const rounds = groupPickupRounds([...byBatch.entries()].map(([batch_id, items]) => ({ batch_id, created_at: items[0].created_at, site: items[0].site, round_id: items[0].complete_group_id, items })));
    const rd = rounds[rounds.length - 1];
    const items = rd.batches.flatMap((b) => b.items);
    const rb = roundBestId(items, basis, best?.id ?? null);
    const sorted = sortForReview(items, rb);
    const imgOf = (r: PRow) => { const m = (r.image_analysis as { match?: unknown } | null)?.match; return typeof m === "number" ? m : null; };
    console.log(`\n### お客様${c.key}: ${c.theme}`);
    console.log(`条件: ${JSON.stringify(c.fields)}`);
    console.log(`🌟 に渡した条件: ${state.rank[c.key]?.map((x) => x.conditions).join(" ／ ")} ／ DeepSeek の🌟: ${state.rank[c.key]?.map((x) => x.stars.join(" ")).join(" ／ ")}`);
    console.log(`画像で分析: ${need.level}（${need.from}）→ 👑 の決め方 ${basis} ／ ${compNote} ／ 全体の👑 id ${best?.id ?? "-"} ／ 回の👑 id ${rb ?? "-"} ／ まとめた回 ${rd.batches.length}つ（${rd.sites.join("+")}）`);
    console.log("| 並び | 物件 | 判定 | 点 | 画像の点 | DeepSeek | 👑 | カードの項目（点） | 項目の和+50 |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const [k, r] of sorted.entries()) {
      const cv = buildPickupCardView(r);
      const cells = cv.cells.filter((x) => x.key !== "score");
      const sum = cells.reduce((a, x) => a + (x.points ?? 0), 0) + BASE_SCORE;
      const capped = r.score != null && (r.score === SCORE_MAX || (r.score <= 20 && sum > r.score));
      const shown = cells.filter((x) => x.points != null || x.key === "ad").map((x) => `${x.written ? "★" : ""}${x.head} ${x.value}${x.sub && x.sub !== "－" ? "/" + x.sub : ""} ${x.points != null ? (x.points >= 0 ? "+" : "") + x.points : ""}${x.note ? "（" + x.note + "）" : ""}${x.tone === "ng" ? "🟥" : x.tone === "unread" ? "⬜" : ""}`);
      console.log(`| ${k + 1} | ${cv.name ?? r.property_name}${r.room_no ? " " + r.room_no : ""}（${r.site}） | ${cv.mark.symbol} | ${r.score ?? "-"} | ${imgOf(r) ?? ""} | ${r.recommended === 2 ? "🌟★" : r.recommended === 1 ? "🌟" : ""} | ${r.id === rb ? "👑" : ""} | ${shown.join("・")} | ${sum}${sum === r.score ? " ✓" : capped ? " (上限)" : " ✗"} |`);
      if (r.score != null && sum !== r.score && !capped) problems.push(`お客様${c.key} id${r.id} ${r.property_name}: 項目の和+50=${sum} ≠ 点 ${r.score}（札 ${(r.reason_codes ?? []).join(" ")}）`);
    }
    // ── 目で見る前の機械の確かめ ──
    // ① 一番オススメ＝点の1位（決め方の点で）
    const pool = items.filter((r) => r.status === "pending" && (basis === "score" ? r.verdict !== "drop" && r.score != null : true));
    const key = (r: PRow) => (basis === "image" && best?.basis === "image" ? imgOf(r) : r.score) ?? -1;
    const top = Math.max(...pool.map(key));
    const bestRow = items.find((r) => r.id === rb);
    if (!bestRow || key(bestRow) !== top) problems.push(`お客様${c.key}: 👑（id ${rb}・${bestRow ? key(bestRow) : "-"}）が点の1位（${top}）ではない`);
    // ② 並びが点の順（👑 の先頭寄せを除く）
    const rest = sorted.filter((r) => r.id !== rb);
    for (let i = 1; i < rest.length; i++) if ((rest[i - 1].score ?? -1) < (rest[i].score ?? -1)) problems.push(`お客様${c.key}: 並びが点の順でない（${rest[i - 1].property_name} ${rest[i - 1].score} → ${rest[i].property_name} ${rest[i].score}）`);
    // ③ 全部合う物件は、同じ AD の段で全部合わない物件より上
    for (const a of items) for (const z of items) {
      const fa = (a.reason_codes ?? []).includes("FIT_ALL") || (a.reason_codes ?? []).includes("FIT_ALL_HALF");
      const fz = summarizeFit(z.reason_codes ?? []).miss > 0;
      if (fa && fz && adTier(a.reason_codes ?? []) === adTier(z.reason_codes ?? []) && a.verdict !== "hold" && (a.score ?? 0) <= (z.score ?? 0)) problems.push(`お客様${c.key}: 全部合う ${a.property_name}(${a.score}) が外れのある ${z.property_name}(${z.score}) 以下（AD 同段）`);
    }
    // ④ 書いた条件の札（AD・全部合うを除く）が同じ物件どうしは、AD の高い方が上
    const sig = (r: PRow) => (r.reason_codes ?? []).filter((x) => !/^AD_|^PROFIT_NEGATIVE$|^FIT_/.test(x)).sort().join(",");
    let pairs = 0;
    for (const a of items) for (const z of items) {
      if (a.id >= z.id || sig(a) !== sig(z) || a.verdict !== z.verdict) continue;
      const ta = adTier(a.reason_codes ?? []), tz = adTier(z.reason_codes ?? []);
      if (ta === tz) continue;
      pairs++;
      const [hi, lo] = ta > tz ? [a, z] : [z, a];
      if ((hi.score ?? 0) <= (lo.score ?? 0)) problems.push(`お客様${c.key}: 条件が同じで AD の高い ${hi.property_name}(${hi.score}) が低い ${lo.property_name}(${lo.score}) 以下`);
    }
    // ⑤ AD 1ヶ月未満・なしの物件の位置
    const low = sorted.map((r, i) => ({ r, i })).filter((x) => (x.r.reason_codes ?? []).some((cc) => AD_LOW.test(cc)));
    console.log(`（条件が同じで AD だけ違う組: ${pairs}組 ／ AD 1ヶ月未満・なし: ${low.map((x) => `${x.i + 1}位 ${x.r.property_name}${x.r.room_no ? " " + x.r.room_no : ""} ${x.r.score}点 [${adCodes(x.r.reason_codes ?? []).join(",")}]`).join("・") || "なし"} ／ 全${sorted.length}件）`);
  }
  console.log(`\n## 機械の確かめ: ${problems.length ? problems.length + "件" : "問題なし"}`);
  for (const p of problems) console.log("- " + p);
}

async function cleanup() {
  const state = loadState();
  if (!state) { console.log("state が無い"); return; }
  const batchIds = Object.values(state.batches).flat();
  const pcids = Object.values(state.customers);
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
  await del("property_pickup_completions", (t) => t.delete().in("property_customer_id", pcids.length ? pcids : ["00000000-0000-0000-0000-000000000000"]).select("group_id"));
  await del("property_pickups", (t) => t.delete().in("batch_id", batchIds.length ? batchIds : ["-"]).select("id"));
  await del("image_details", (t) => t.delete().like("image_url", `%yst=${state.stamp}%`).select("image_url"));
  await del("property_customers", (t) => t.delete().in("id", pcids.length ? pcids : ["00000000-0000-0000-0000-000000000000"]).select("id"));
  console.log(`property_sheet_facts: 新しい行 ${factsDeleted}件 消した・照合の答え ${factsRestored}件 元に戻した`);
  const left = await Promise.all([
    sb.from("property_pickups").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA),
    sb.from("property_customers").select("id", { count: "exact", head: true }).like("customer_name", "YUMAテスト%"),
    sb.from("image_details").select("image_url", { count: "exact", head: true }).like("image_url", "%yst=%"),
  ]);
  console.log(`残り: YUMA の property_pickups ${left[0].count} ／ YUMAテストのお客様 ${left[1].count} ／ ?yst= の image_details ${left[2].count}`);
}

(async () => {
  if (has("run")) await run();
  if (has("report")) await report();
  if (has("cleanup")) await cleanup();
})().catch((e) => { console.error(e); process.exit(1); });
