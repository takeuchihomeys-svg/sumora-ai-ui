// YUMA（テスト用会話）で、売上サポの「完了でまとめる」（/api/property-pickups/complete）を本番の DB・本番の物件資料で確かめる
// 2026-09-25 竹内「まとめられていない。スタッフモードで送った時は、完了ボタン押したらリアプロと itandi の全部分析されるようにする」
//
// やること（--run）:
//   ① テスト用のお客様（「YUMAテスト_完了」・画像でしか分からない希望＝WIC・対面キッチン）を作る
//   ② 本番の property_pickups の物件資料（リアプロ id 34〜39・itandi id 50,51,54,57,62,65,67）を写して、リアプロの回と itandi の回の2回に分けて入れる
//      （画像の分析は空・会話は YUMA）
//   ③ route の POST を本番と同じ形で呼ぶ: ブレイン OFF（何もしない）→ 2台の PC から同時（Promise.all）→ 二重押し
//   ④ 後ろの処理（自動の読み取り・順位・👑）が終わるまで待ち、まとめ ID・llm_usage_logs（DeepSeek だけか）・👑 がまとめた全件から選ばれたかを出す
// 片付け（--cleanup）: property_pickups（写した行）・property_pickup_completions・property_customers（テスト用）・
//   property_sheet_facts（新しい行は消し、照合の答え wants_judged は元に戻す）
// お客様の名前・電話は使わない。資料は物件の資料だけ
//
// 実行: npx tsx --env-file=.env.local scripts/yuma-pickup-complete-test.ts --run --state=<json>
//       npx tsx --env-file=.env.local scripts/yuma-pickup-complete-test.ts --cleanup --state=<json>
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { NextRequest } from "next/server";
import { pickCustomerBest, type BestCandidateRow } from "../app/lib/pickup-best";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const has = (k: string) => process.argv.includes(`--${k}`);
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const STATE = arg("state") ?? "yuma-pickup-complete-state.json";
const RP_IDS = [34, 35, 36, 37, 38, 39];
const IT_IDS = [50, 51, 54, 57, 62, 65, 67];

type State = { stamp: number; startedIso: string; customerId: string | null; batchIds: string[]; ids: number[]; factsSnapshot: Array<{ id: number; wants_judged: unknown; updated_at: string | null }>; factsMaxId: number };
const loadState = (): State | null => existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) as State : null;
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 1));

const COPY_COLS = "id, site, rank, property_name, room_no, summary_text, pdf_url, pdf_blob_url, pdf_text, pdf_has_text, verdict, score, reason_codes, reasons_ja, ad_yen, profit_yen, recommended, page_image_url, agent_image_url, trim_image_url, image_lines, image_facts, equipment, terms, location";

async function callRoute(body: Record<string, unknown>) {
  const { POST } = await import("../app/api/property-pickups/complete/route");
  const req = new NextRequest("http://localhost/api/property-pickups/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const res = await POST(req);
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

async function run() {
  if (loadState()) throw new Error(`state がもうある（先に --cleanup）: ${STATE}`);
  const stamp = Date.now();
  const { data: facts } = await sb.from("property_sheet_facts").select("id, wants_judged, updated_at").order("id");
  const state: State = { stamp, startedIso: new Date().toISOString(), customerId: null, batchIds: [], ids: [], factsSnapshot: (facts ?? []) as State["factsSnapshot"], factsMaxId: Math.max(0, ...((facts ?? []) as Array<{ id: number }>).map((f) => f.id)) };
  saveState(state);

  // ① テスト用のお客様
  const { data: pc, error: pcErr } = await sb.from("property_customers").insert({
    customer_name: "YUMAテスト_完了", rent_max: 72000, floor_plan: "1K", floor_area_min: 20,
    preferences: "ウォークインクローゼットが欲しい。キッチンは対面キッチンが良い。収納が多めだと嬉しい",
  }).select("id").single();
  if (pcErr) throw new Error(`お客様を作れない: ${pcErr.message}`);
  state.customerId = (pc as { id: string }).id; saveState(state);
  console.log("テスト用のお客様:", state.customerId.slice(0, 8));

  // ② 本番の資料を写して2回に分けて入れる（リアプロ 10分前・itandi 5分前）
  const { data: src, error: sErr } = await sb.from("property_pickups").select(COPY_COLS).in("id", [...RP_IDS, ...IT_IDS]);
  if (sErr) throw new Error(sErr.message);
  const byId = new Map(((src ?? []) as Array<Record<string, unknown> & { id: number }>).map((r) => [r.id, r]));
  const mk = (ids: number[], batch: string, at: string) => ids.map((id) => byId.get(id)).filter(Boolean).map((r) => {
    const { id: _id, ...rest } = r as Record<string, unknown> & { id: number };
    return { ...rest, batch_id: batch, created_at: at, property_customer_id: state.customerId, conversation_id: YUMA, customer_name: "YUMAテスト_完了", status: "pending", image_analysis: null };
  });
  const rpBatch = `yuma_complete_rp_${stamp}.pdf`, itBatch = `yuma_complete_it_${stamp}.pdf`;
  state.batchIds = [rpBatch, itBatch]; saveState(state);
  for (const [rows, label] of [[mk(RP_IDS, rpBatch, new Date(stamp - 10 * 60_000).toISOString()), "リアプロ"], [mk(IT_IDS, itBatch, new Date(stamp - 5 * 60_000).toISOString()), "itandi"]] as const) {
    const { data, error } = await sb.from("property_pickups").insert(rows as unknown as Record<string, unknown>[]).select("id");
    if (error) throw new Error(`${label} の回を入れられない: ${error.message}`);
    state.ids.push(...((data ?? []) as Array<{ id: number }>).map((r) => r.id)); saveState(state);
    console.log(`${label} の回: ${(data ?? []).length}件`);
  }

  // ③ route を呼ぶ
  const off = await callRoute({ property_customer_id: state.customerId, brain: false, mode: "staff", trigger: "viewed" });
  console.log("\n[ブレイン OFF]", off.status, JSON.stringify(off.json));
  const { data: afterOff } = await sb.from("property_pickups").select("id").in("id", state.ids).not("complete_group_id", "is", null);
  console.log("  → まとめ ID が付いた行:", (afterOff ?? []).length, "（0 が正しい）");

  const t0 = Date.now();
  const [a, b] = await Promise.all([
    callRoute({ property_customer_id: state.customerId, brain: true, mode: "staff", trigger: "viewed", requested_by: "PC-A" }),
    callRoute({ property_customer_id: state.customerId, brain: true, mode: "staff", trigger: "sent", requested_by: "PC-B" }),
  ]);
  console.log(`\n[2台から同時] ${Date.now() - t0}ms`);
  console.log("  PC-A:", a.status, JSON.stringify(a.json));
  console.log("  PC-B:", b.status, JSON.stringify(b.json));
  const again = await callRoute({ property_customer_id: state.customerId, brain: true, mode: "staff", trigger: "viewed" });
  console.log("[二重押し]", again.status, JSON.stringify(again.json));

  // ④ 後ろの処理を待つ
  const gid = (a.json.group_id ?? b.json.group_id) as string | null;
  if (!gid) throw new Error("まとめ ID が無い");
  let comp: Record<string, unknown> | null = null;
  for (let i = 0; i < 80; i++) {
    const { data } = await sb.from("property_pickup_completions").select("*").eq("group_id", gid).maybeSingle();
    comp = data as Record<string, unknown> | null;
    if (comp && comp.status !== "running") break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("\n[まとめの行]", JSON.stringify(comp));
  await report(gid, state);
}

async function report(gid: string, state: State) {
  const { data: rows } = await sb.from("property_pickups").select("id, created_at, batch_id, site, rank, status, recommended, property_name, room_no, verdict, score, image_analysis, complete_group_id, complete_rank").in("id", state.ids).order("complete_rank", { ascending: true });
  const rs = (rows ?? []) as Array<BestCandidateRow & { site: string; score: number | null; complete_group_id: string | null; complete_rank: number | null }>;
  console.log(`\n[まとめた行] ${rs.length}件・まとめ ID ${[...new Set(rs.map((r) => r.complete_group_id))].join(",")}（${gid}）`);
  for (const r of rs) {
    const ia = r.image_analysis as { match?: number | null; auto?: unknown } | null;
    console.log(`  順位${String(r.complete_rank).padStart(2)}  ${r.site.padEnd(7)} 【${r.rank}】${r.recommended ? "🌟".repeat(r.recommended > 1 ? 2 : 1) : "  "} ${r.property_name.slice(0, 22).padEnd(22)} ${r.verdict ?? "-"} ${r.score ?? "-"}点  画像:${ia ? (ia.match ?? "点なし") + (ia.auto ? "(自動)" : "") : "未分析"}`);
  }
  const bestAll = pickCustomerBest(rs, { windowHours: 49 });
  const bestRp = pickCustomerBest(rs.filter((r) => r.site === "realpro"), { windowHours: 49 });
  const bestIt = pickCustomerBest(rs.filter((r) => r.site === "itandi"), { windowHours: 49 });
  const { data: comp } = await sb.from("property_pickup_completions").select("best_id, best_basis, result").eq("group_id", gid).maybeSingle();
  console.log(`\n[👑] まとめの best_id=${(comp as { best_id?: number } | null)?.best_id}（${(comp as { best_basis?: string } | null)?.best_basis}）／まとめた全件の pickCustomerBest=${bestAll?.id ?? null}（${bestAll?.match ?? "-"}点）／リアプロだけ=${bestRp?.id ?? null}（${bestRp?.match ?? "-"}）・itandi だけ=${bestIt?.id ?? null}（${bestIt?.match ?? "-"}）`);
  const { data: logs } = await sb.from("llm_usage_logs").select("created_at, model, action, route, status, input_uncached, cache_read, output_tokens, conversation_id").gte("created_at", state.startedIso).order("created_at");
  const mine = ((logs ?? []) as Array<{ model: string; action: string | null; route: string | null; status: string | null; conversation_id: string | null; input_uncached: number | null; cache_read: number | null; output_tokens: number | null }>).filter((l) => l.conversation_id === YUMA || /pickup|sheet/.test(l.action ?? ""));
  const byModel: Record<string, number> = {};
  for (const l of mine) { const k = `${l.model}|${l.action}`; byModel[k] = (byModel[k] ?? 0) + 1; }
  console.log(`\n[llm_usage_logs] テスト開始から ${mine.length}件（YUMA・pickup の action）`, byModel);
  console.log("  Claude の行:", mine.filter((l) => /claude|haiku|sonnet|opus/i.test(l.model)).length);
}

async function cleanup() {
  const state = loadState();
  if (!state) { console.log("state が無い"); return; }
  const { data: pk } = await sb.from("property_pickups").select("id, complete_group_id").in("batch_id", state.batchIds.length ? state.batchIds : ["-"]);
  const pkRows = (pk ?? []) as Array<{ id: number; complete_group_id: string | null }>;
  const pkIds = pkRows.map((r) => r.id);
  const gids = [...new Set(pkRows.map((r) => r.complete_group_id).filter((g): g is string => !!g))];
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
  await del("property_pickup_completions", (t) => t.delete().in("group_id", gids.length ? gids : ["-"]).select("group_id"));
  await del("property_pickups", (t) => t.delete().in("batch_id", state.batchIds.length ? state.batchIds : ["-"]).select("id"));
  await del("property_customers", (t) => t.delete().eq("id", state.customerId ?? "00000000-0000-0000-0000-000000000000").select("id"));
  console.log(`property_sheet_facts: 新しい行 ${factsDeleted}件 消した・照合の答え ${factsRestored}件 元に戻した`);
}

(async () => {
  if (has("run")) await run();
  if (has("cleanup")) await cleanup();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
