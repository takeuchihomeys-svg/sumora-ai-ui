// YUMA（テスト用会話）で、売上サポの「10分の自動まとめ」と「お客様ごとの 👑 の決め方」を本番の DB・本番の物件資料で確かめる
// 2026-09-25 竹内「画像で分析必要なお客さんなら画像で分析の点、不要なお客さんは判定した点」
//            「最後にスタッフモードで指定したお客さん…10分たてば自動的に送られた物件まとめて…まとめて判定する」
//
// やること（--run）:
//   ① テスト用のお客様を2人作る: A＝画像で分析が要る（WIC・対面キッチン）／B＝要らない（条件欄に画像でしか分からない希望なし）
//   ② それぞれに本番の property_pickups の物件資料を写し、リアプロの回（14分前）と itandi の回（6分前）を入れる（画像の分析は空）。
//      会話は A だけ YUMA。B は会話を付けない（YUMA の会話に「バストイレ別・収納」の発言があり、自動の読み取りは会話の希望も見るので
//      B も「画像で分析が要る」になる＝1回目の実行でそうなった。画像が要らないお客様を作るため B の行は会話なし）
//   ③ まだ10分経っていない: Cron（runAutoCompleteSweep・このお客様だけ）→ 0件／拡張の alarm（/complete idle:true）→ not_due と due_at
//   ④ itandi の回の created_at を 10分1秒前にずらす → A は Cron・B は売上サポの詳細を開いた時（GET view=detail）でまとまる
//   ⑤ 後ろの処理（自動の読み取り・順位・👑）を待ち、👑 がお客様ごとの決まりどおりか・画面の 👑 とまとめの best_id が同じかを出す
//   ⑥ もう一度 Cron → 0件（冪等）
// 片付け（--cleanup）: property_pickups（写した行）・property_pickup_completions・property_customers（テスト用2人）・
//   property_sheet_facts（新しい行は消し、照合の答え wants_judged は元に戻す）
// お客様の名前・電話は使わない。資料は物件の資料だけ
//
// 実行: npx tsx --env-file=.env.local scripts/yuma-pickup-auto-complete-test.ts --run --state=<json>
//       npx tsx --env-file=.env.local scripts/yuma-pickup-auto-complete-test.ts --cleanup --state=<json>
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { NextRequest } from "next/server";
import { pickCustomerBest, bestBasisFor, customerImageNeed, type BestCandidateRow } from "../app/lib/pickup-best";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const has = (k: string) => process.argv.includes(`--${k}`);
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const STATE = arg("state") ?? "yuma-pickup-auto-complete-state.json";
const RP_IDS = [34, 35, 36, 37, 38, 39];
const IT_IDS = [50, 51, 54, 57, 62, 65, 67];
const COPY_COLS = "id, site, rank, property_name, room_no, summary_text, pdf_url, pdf_blob_url, pdf_text, pdf_has_text, verdict, score, reason_codes, reasons_ja, ad_yen, profit_yen, recommended, page_image_url, agent_image_url, trim_image_url, image_lines, image_facts, equipment, terms, location";

type Cust = { key: "A" | "B"; id: string; rpBatch: string; itBatch: string; ids: number[] };
type State = { stamp: number; startedIso: string; customers: Cust[]; factsSnapshot: Array<{ id: number; wants_judged: unknown; updated_at: string | null }>; factsMaxId: number };
const loadState = (): State | null => existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) as State : null;
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PREFS: Record<"A" | "B", string> = {
  A: "ウォークインクローゼットが欲しい。キッチンは対面キッチンが良い",
  B: "家賃は7万円まで。駅から徒歩10分以内",
};

async function callComplete(body: Record<string, unknown>) {
  const { POST } = await import("../app/api/property-pickups/complete/route");
  const res = await POST(new NextRequest("http://localhost/api/property-pickups/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}
async function openDetail(pcid: string) {
  const { GET } = await import("../app/api/property-pickups/route");
  const res = await GET(new NextRequest(`http://localhost/api/property-pickups?view=detail&pcid=${pcid}&batches=5`));
  return await res.json() as { ok: boolean; customer?: { best?: Record<string, unknown> | null; image_need?: { level: string } } };
}

async function run() {
  if (loadState()) throw new Error(`state がもうある（先に --cleanup）: ${STATE}`);
  const { runAutoCompleteSweep } = await import("../app/lib/pickup-complete-server");
  const stamp = Date.now();
  const { data: facts } = await sb.from("property_sheet_facts").select("id, wants_judged, updated_at").order("id");
  const state: State = { stamp, startedIso: new Date().toISOString(), customers: [], factsSnapshot: (facts ?? []) as State["factsSnapshot"], factsMaxId: Math.max(0, ...((facts ?? []) as Array<{ id: number }>).map((f) => f.id)) };
  saveState(state);
  const { data: src, error: sErr } = await sb.from("property_pickups").select(COPY_COLS).in("id", [...RP_IDS, ...IT_IDS]);
  if (sErr) throw new Error(sErr.message);
  const byId = new Map(((src ?? []) as Array<Record<string, unknown> & { id: number }>).map((r) => [r.id, r]));

  for (const key of ["A", "B"] as const) {
    const need = customerImageNeed([], { preferences: PREFS[key] });
    console.log(`お客様${key}: 画像で分析 ${need.level}（${need.labels.join("・") || "なし"}）→ 👑 は ${bestBasisFor(need) === "image" ? "画像で分析の点" : "判定の点"}`);
    const { data: pc, error: pcErr } = await sb.from("property_customers").insert({ customer_name: `YUMAテスト_自動まとめ${key}`, rent_max: 72000, floor_plan: "1K", preferences: PREFS[key] }).select("id").single();
    if (pcErr) throw new Error(`お客様を作れない: ${pcErr.message}`);
    const c: Cust = { key, id: (pc as { id: string }).id, rpBatch: `yuma_auto_rp_${key}_${stamp}.pdf`, itBatch: `yuma_auto_it_${key}_${stamp}.pdf`, ids: [] };
    state.customers.push(c); saveState(state);
    const mk = (ids: number[], batch: string, at: string) => ids.map((id) => byId.get(id)).filter(Boolean).map((r) => {
      const { id: _id, ...rest } = r as Record<string, unknown> & { id: number };
      return { ...rest, batch_id: batch, created_at: at, property_customer_id: c.id, conversation_id: key === "A" ? YUMA : null, customer_name: `YUMAテスト_自動まとめ${key}`, status: "pending", image_analysis: null };
    });
    for (const [rows, label] of [[mk(RP_IDS, c.rpBatch, new Date(stamp - 14 * 60_000).toISOString()), "リアプロ 14分前"], [mk(IT_IDS, c.itBatch, new Date(stamp - 6 * 60_000).toISOString()), "itandi 6分前"]] as const) {
      const { data, error } = await sb.from("property_pickups").insert(rows as unknown as Record<string, unknown>[]).select("id");
      if (error) throw new Error(`${label} の回を入れられない: ${error.message}`);
      c.ids.push(...((data ?? []) as Array<{ id: number }>).map((r) => r.id)); saveState(state);
      console.log(`  ${label}: ${(data ?? []).length}件`);
    }
  }
  const [A, B] = state.customers;

  console.log("\n[③ まだ10分経っていない（最後の itandi から6分）]");
  const s1 = await runAutoCompleteSweep({ onlyCustomer: A.id });
  console.log("  Cron（A）: due", s1.due, "・waiting", s1.waiting, "・まとめた", s1.claimed.length, "（0 が正しい）");
  const e1 = await callComplete({ property_customer_id: B.id, brain: true, mode: "staff", idle: true });
  console.log("  拡張の alarm（B・idle）:", e1.status, JSON.stringify(e1.json));
  const d1 = await openDetail(B.id);
  const { data: g0 } = await sb.from("property_pickups").select("id").in("id", [...A.ids, ...B.ids]).not("complete_group_id", "is", null);
  console.log("  詳細を開いた（B）→ まとめ ID が付いた行:", (g0 ?? []).length, "（0 が正しい）・画面の 👑:", d1.customer?.best ? `${d1.customer.best.id}（${d1.customer.best.basis}・${d1.customer.best.from}）` : "なし");

  console.log("\n[④ itandi の回を 10分1秒前にずらす]");
  const shifted = new Date(Date.now() - (10 * 60_000 + 1000)).toISOString();
  for (const c of state.customers) await sb.from("property_pickups").update({ created_at: shifted }).eq("batch_id", c.itBatch);
  const t0 = Date.now();
  const s2 = await runAutoCompleteSweep({ onlyCustomer: A.id });
  console.log(`  Cron（A）: ${Date.now() - t0}ms`, JSON.stringify(s2.claimed));
  const t1 = Date.now();
  const d2 = await openDetail(B.id);
  console.log(`  詳細を開いた（B）: ${Date.now() - t1}ms・ok=${d2.ok}`);

  const gids: Record<string, string | null> = {};
  for (const c of state.customers) {
    const { data } = await sb.from("property_pickups").select("complete_group_id").in("id", c.ids);
    const set = [...new Set(((data ?? []) as Array<{ complete_group_id: string | null }>).map((r) => r.complete_group_id))];
    gids[c.key] = set.length === 1 ? set[0] : null;
    console.log(`  お客様${c.key}: ${c.ids.length}件のまとめ ID = ${JSON.stringify(set)}`);
  }
  // ⑤ 後ろの処理を待つ
  for (const c of state.customers) {
    const gid = gids[c.key];
    if (!gid) continue;
    let comp: Record<string, unknown> | null = null;
    for (let i = 0; i < 80; i++) {
      const { data } = await sb.from("property_pickup_completions").select("status, trigger, requested_by, best_id, best_basis, result").eq("group_id", gid).maybeSingle();
      comp = data as Record<string, unknown> | null;
      if (comp && comp.status !== "running") break;
      await sleep(5000);
    }
    console.log(`\n[お客様${c.key} のまとめ] ${JSON.stringify(comp)}`);
    await report(c, gid);
  }
  console.log("\n[⑥ もう一度 Cron（冪等）]");
  for (const c of state.customers) {
    const s3 = await runAutoCompleteSweep({ onlyCustomer: c.id });
    console.log(`  お客様${c.key}: due ${s3.due}・まとめた ${s3.claimed.length}（0 が正しい）`);
  }
  const e2 = await callComplete({ property_customer_id: A.id, brain: true, mode: "staff", idle: true });
  console.log("  拡張の alarm（A・後から鳴った）:", JSON.stringify(e2.json));
  const { data: logs } = await sb.from("llm_usage_logs").select("model, action, conversation_id").gte("created_at", state.startedIso);
  const mine = ((logs ?? []) as Array<{ model: string; action: string | null; conversation_id: string | null }>).filter((l) => l.conversation_id === YUMA || /pickup|sheet/.test(l.action ?? ""));
  const byModel: Record<string, number> = {};
  for (const l of mine) { const k = `${l.model}|${l.action}`; byModel[k] = (byModel[k] ?? 0) + 1; }
  console.log(`\n[llm_usage_logs] ${mine.length}件`, byModel, "Claude:", mine.filter((l) => /claude|haiku|sonnet|opus/i.test(l.model)).length);
}

async function report(c: Cust, gid: string) {
  const { data: rows } = await sb.from("property_pickups").select("id, created_at, batch_id, site, rank, status, recommended, property_name, room_no, verdict, score, image_analysis, complete_rank").in("id", c.ids).order("complete_rank", { ascending: true });
  const rs = (rows ?? []) as Array<BestCandidateRow & { site: string; score: number | null; complete_rank: number | null }>;
  for (const r of rs) {
    const ia = r.image_analysis as { match?: number | null } | null;
    console.log(`  順位${String(r.complete_rank).padStart(2)}  ${r.site.padEnd(7)} 【${r.rank}】 id${r.id} ${r.verdict ?? "-"} 判定${r.score ?? "-"}点  画像:${ia ? (ia.match ?? "点なし") : "未分析"}`);
  }
  const { data: comp } = await sb.from("property_pickup_completions").select("best_id, best_basis").eq("group_id", gid).maybeSingle();
  const cp = comp as { best_id: number | null; best_basis: string | null } | null;
  const byImage = pickCustomerBest(rs, { windowHours: 49, basis: "image" });
  const byScore = pickCustomerBest(rs, { windowHours: 49, basis: "score" });
  const d = await openDetail(c.id);
  const sb2 = d.customer?.best ?? null;
  const want = c.key === "A" ? "image" : "score";
  const expected = want === "image" ? byImage : byScore;
  console.log(`  👑 まとめの best_id=${cp?.best_id}（${cp?.best_basis}）／画像の点で決めると ${byImage?.id}（${byImage?.match}点・basis ${byImage?.basis}）／判定の点で決めると ${byScore?.id}（判定${byScore?.score}点）`);
  console.log(`  画面の 👑: ${sb2 ? `${sb2.id}（basis ${sb2.basis}・${sb2.from}・画像${sb2.match}・判定${sb2.score}）` : "なし"}・image_need=${d.customer?.image_need?.level}`);
  console.log(`  → 決まりどおり（${want}）: ${cp?.best_id === expected?.id ? "○" : "×"}・画面とまとめが同じ: ${sb2?.id === cp?.best_id ? "○" : "×"}・順位1番が 👑: ${rs[0]?.id === cp?.best_id ? "○" : "×"}`);
}

async function cleanup() {
  const state = loadState();
  if (!state) { console.log("state が無い"); return; }
  const batchIds = state.customers.flatMap((c) => [c.rpBatch, c.itBatch]);
  const { data: pk } = await sb.from("property_pickups").select("id, complete_group_id").in("batch_id", batchIds.length ? batchIds : ["-"]);
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
  await del("property_pickups", (t) => t.delete().in("batch_id", batchIds.length ? batchIds : ["-"]).select("id"));
  await del("property_customers", (t) => t.delete().in("id", state.customers.map((c) => c.id).concat(["00000000-0000-0000-0000-000000000000"])).select("id"));
  console.log(`property_sheet_facts: 新しい行 ${factsDeleted}件 消した・照合の答え ${factsRestored}件 元に戻した`);
}

(async () => {
  if (has("run")) await run();
  if (has("cleanup")) await cleanup();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
