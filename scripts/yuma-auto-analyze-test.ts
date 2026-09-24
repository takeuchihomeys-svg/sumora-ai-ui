// scripts/yuma-auto-analyze-test.ts — 売上サポに届いた時の自動の読み取り・判定の穴埋め（エリア・通勤・下限・も可）・条件の要約を YUMA で確かめる
//
// 2026-09-25 竹内「売上サポに送られたら、条件指定あれば間取り図とか設備も自動的に読み取るようにする」
//   「家賃の下限」「1DKも可」「文章の要約」「エリア」「通勤」
//
// やること（書き込みはテスト顧客と YUMA の会話の行だけ・最後に片付ける）:
//   A. テスト顧客「YUMA_AUTO_TEST_A」（WIC・対面キッチン＝画像でしか分からない希望あり／下限・1DKも可・エリア・通勤・白基調の自由文）
//      → 本番と同じ recordPickupBatch（既存の itandi の資料 4件を借りる・pdf_url は渡さない＝sent_properties に書かない）
//      → 行の札（AREA_*・COMMUTE_*・RENT_BELOW_MIN・FLOOR_PLAN_ALT_MATCH）・場所の1行・条件の要約（DeepSeek・保存）を見る
//      ⚠ .env.local に BLOB_READ_WRITE_TOKEN が無いので、recordPickupBatch の中では資料の Blob が置けず自動の読み取りは「資料なし」で飛ばす。
//        そこで行の pdf_blob_url に借りた資料の URL を入れてから、本番と同じ autoAnalyzeBatch を呼ぶ（本番は Blob があるので中で動く）
//      → 2回目の autoAnalyzeBatch は保存済みで DeepSeek 0回・条件の要約も2回目は呼ばない（ハッシュが同じ）
//   B. テスト顧客「YUMA_AUTO_TEST_B」（宅配BOX・2階以上＝資料の文字で決まる希望だけ）→ autoAnalyzeBatch が読まない（DeepSeek 0回）
//   費用・キャッシュ: llm_usage_logs（action=pickup_image_analysis_auto / condition_summary・conversation_id=YUMA）を数える
// 片付け: property_pickups（batch_id like 'YUMA_auto_%'）・テストで増えた property_sheet_facts（実行後に増えた行）と wants_judged（実行前に戻す）・テスト顧客
// 実行: npx tsx --env-file=.env.local scripts/yuma-auto-analyze-test.ts [--keep]（--keep は片付けない）
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const KEEP = process.argv.includes("--keep");
const log = (...a: unknown[]) => console.log(...a);

// 2026-09-25 2回目: 「1DKも可」は自由文に・「梅田まで30分以内」「難波より南は避けたい」・下限 7万（下限の85%未満に札）
const CUST_A = {
  customer_name: "YUMA_AUTO_TEST_A", status: "property_search",
  rent_max: 80_000, rent_min: 70_000, floor_plan: "1K", floor_area_min: 22, walk_minutes: 10,
  desired_area: "東三国・新大阪・淀川区・なんば", other_requests: "梅田まで30分以内、難波より南は避けたい、白基調のお部屋が良い",
  preferences: "WICが欲しい、対面キッチン希望、1DKも可", ng_points: "1階",
};
/** 借りる資料（物件資料だけ・お客様の情報は持ってこない）。itandi は 50〜67 から・リアプロは 35〜45 から */
const SRC_IDS: Record<"itandi" | "realpro", number[]> = { itandi: [50, 52, 55], realpro: [35, 36, 45] };
const CUST_B = { customer_name: "YUMA_AUTO_TEST_B", status: "property_search", rent_max: 80_000, floor_plan: "1K", preferences: "宅配BOX必須、2階以上" };

async function fetchBase64(url: string): Promise<string | null> {
  try { const r = await fetch(url); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()).toString("base64"); } catch { return null; }
}
const clean = (s: string, n: number) => s.split("\n").filter((l) => !/^🧠/.test(l)).join("\n").replace(/^【\d+[^】]*】/u, `【${n}】`);

async function usageSince(since: string) {
  const { data } = await sb.from("llm_usage_logs").select("action, model, input_uncached, cache_read, output_tokens, duration_ms, conversation_id, status").gte("created_at", since).in("action", ["pickup_image_analysis_auto", "pickup_image_analysis", "condition_summary", "property_image_detail", "property_brain_image"]).limit(500);
  const agg: Record<string, { n: number; yuma: number; input: number; cacheRead: number; output: number; ms: number }> = {};
  for (const r of (data ?? []) as Array<{ action: string; input_uncached: number | null; cache_read: number | null; output_tokens: number | null; duration_ms: number | null; conversation_id: string | null }>) {
    const a = agg[r.action] ??= { n: 0, yuma: 0, input: 0, cacheRead: 0, output: 0, ms: 0 };
    a.n++; if (r.conversation_id === YUMA) a.yuma++;
    a.input += r.input_uncached ?? 0; a.cacheRead += r.cache_read ?? 0; a.output += r.output_tokens ?? 0; a.ms += r.duration_ms ?? 0;
  }
  return agg;
}

async function main() {
  const started = new Date().toISOString();
  const { recordPickupBatch } = await import("../app/lib/property-pickups-server");
  const { autoAnalyzeBatch } = await import("../app/lib/pickup-auto-analyze");
  const { loadConditionSummary } = await import("../app/lib/condition-summary-server");

  // 実行前の写し（property_sheet_facts の wants_judged は共有の保存なので戻す）
  const { data: factsBefore } = await sb.from("property_sheet_facts").select("id, wants_judged").limit(5000);
  const beforeIds = new Set(((factsBefore ?? []) as Array<{ id: number }>).map((r) => r.id));

  // 借りる資料（物件資料だけ・お客様の情報は持ってこない）。本番の merge-pdfs と同じく、資料の文字層で説明文を補ってから渡す
  const { enrichSummariesFromPdf } = await import("../app/lib/pickup-rank");
  type Src = { id: number; summary_text: string; pdf_blob_url: string; site: string };
  const srcBySite: Array<{ site: "itandi" | "realpro"; list: Src[]; b64: Array<string | null>; summaries: string[] }> = [];
  for (const site of ["itandi", "realpro"] as const) {
    const { data: src } = await sb.from("property_pickups").select("id, summary_text, pdf_blob_url, site").in("id", SRC_IDS[site]).order("id");
    const list = ((src ?? []) as Src[]).filter((r) => r.pdf_blob_url);
    const b64 = await Promise.all(list.map((r) => fetchBase64(r.pdf_blob_url)));
    const summaries = await enrichSummariesFromPdf(list.map((r, k) => clean(r.summary_text, k + 1)), b64, "yuma-auto");
    srcBySite.push({ site, list, b64, summaries });
    log(`借りた資料 ${site}: ${list.map((r) => `#${r.id}`).join(" ")}（PDF ${b64.filter(Boolean).length}/${list.length}）`);
  }

  const made: string[] = [];
  const batches: string[] = [];
  try {
    for (const [label, cust] of [["A", CUST_A], ["B", CUST_B]] as const) {
      const { data: c, error } = await sb.from("property_customers").insert(cust).select("id").single();
      if (error || !c) throw new Error(`テスト顧客を作れない: ${error?.message}`);
      const pcid = (c as { id: string }).id;
      made.push(pcid);
     for (const { site, list, b64, summaries } of srcBySite) {
      const batchId = `YUMA_auto_${label}_${site}_${Date.now()}.pdf`;
      batches.push(batchId);
      const t0 = Date.now();
      // B は YUMA の会話（テストで WIC・バストイレ別を何度も話している）を材料にしない＝条件欄だけで「読まない」を確かめる
      const convForWants = label === "A" ? YUMA : null;
      const rec = await recordPickupBatch({
        batchId, propertyCustomerId: pcid, conversationId: convForWants, customerName: cust.customer_name, site,
        summaries, pdfUrls: list.map(() => null), pdfBase64List: b64,
      });
      log(`\n■ ${label} [${site}]: 条件の要約 DeepSeek ${rec.summaryCalled ? "呼んだ" : "呼ばない"}`);
      log(`\n■ ${label}: recordPickupBatch ${Date.now() - t0}ms`, JSON.stringify(rec));
      const { data: rows } = await sb.from("property_pickups").select("id, rank, verdict, score, reason_codes, location, image_analysis").eq("batch_id", batchId).order("rank");
      for (const r of (rows ?? []) as Array<{ id: number; rank: number; verdict: string; score: number; reason_codes: string[]; location: { line?: string } | null }>) {
        const pick = r.reason_codes.filter((x) => /^(AREA|COMMUTE|RENT_BELOW|FLOOR_PLAN|SQM|EQUIP_FLOOR|RENT_OK)/.test(x));
        log(`   【${r.rank}】#${r.id} ${r.verdict} ${r.score}点 ${pick.join(" ")}\n       ${r.location?.line ?? "（場所なし）"}`);
      }
      // 本番は Blob があるので recordPickupBatch の中で読む。テストでは借りた資料の URL を入れてから同じ関数を呼ぶ
      const ids = ((rows ?? []) as Array<{ id: number; rank: number }>).map((r) => r.id);
      for (const r of (rows ?? []) as Array<{ id: number; rank: number }>) {
        await sb.from("property_pickups").update({ pdf_blob_url: list[r.rank - 1]?.pdf_blob_url ?? null }).eq("id", r.id);
      }
      const a1 = await autoAnalyzeBatch({ ids, propertyCustomerId: pcid, conversationId: convForWants, deadlineAt: Date.now() + 150_000 });
      log(`   自動の読み取り 1回目: level=${a1.level} 推奨=${a1.labels.join("・") || "-"} 対象=${a1.targets} 読めた=${a1.analyzed} 失敗=${a1.failed} 飛ばした=${a1.skipped.map((s) => s.why).join(",") || "-"} DeepSeek=${a1.calls}回 入力=${a1.input}（命中 ${a1.cacheHit}） 出力=${a1.output} ${a1.ms}ms`);
      if (a1.level === "recommended") {
        const a2 = await autoAnalyzeBatch({ ids, propertyCustomerId: pcid, conversationId: convForWants });
        log(`   自動の読み取り 2回目（保存済み）: 対象=${a2.targets} DeepSeek=${a2.calls}回 飛ばした=${a2.skipped.map((s) => s.why).join(",")}`);
        const { data: after } = await sb.from("property_pickups").select("rank, image_analysis").in("id", ids).order("rank");
        for (const r of (after ?? []) as Array<{ rank: number; image_analysis: { match?: number | null; auto?: { labels?: string[] }; review?: { status?: string } } | null }>) {
          log(`     【${r.rank}】画像で分析 ${r.image_analysis ? `${r.image_analysis.match ?? "-"}点${r.image_analysis.review?.status ? `・${r.image_analysis.review.status}` : ""}・auto=${r.image_analysis.auto ? "○" : "×"}` : "なし"}`);
        }
      }
     }
      // 👑（画面と同じ pickCustomerBest・回をまたいで一番）
      {
        const { pickCustomerBest } = await import("../app/lib/pickup-best");
        const { data: all } = await sb.from("property_pickups").select("id, batch_id, created_at, rank, status, recommended, property_name, room_no, image_analysis").eq("property_customer_id", pcid);
        const best = pickCustomerBest((all ?? []) as never);
        log(`\n   👑 ${best ? `#${best.id}【${best.rank}】${best.match}点（点あり ${best.scored}・点なし ${best.unscored}・要確認 ${best.needs_check}・未分析 ${best.not_analyzed}・回 ${best.batches}）` : "なし（点の付いた物件なし）"}`);
      }
      const s2 = await loadConditionSummary(pcid, { allowLlm: true, conversationId: label === "A" ? YUMA : null });
      log(`\n   条件の要約（最後にもう一度・DeepSeek ${s2?.called ? "呼んだ" : "呼ばない"}）: ${s2?.line}\n   照らせない条件: ${s2?.uncheckable.join("／") || "-"}`);
    }
    await new Promise((r) => setTimeout(r, 2500)); // 使用量の記録（非同期）を待つ
    log("\n■ llm_usage_logs（テスト中）:", JSON.stringify(await usageSince(started), null, 1));
  } finally {
    if (KEEP) { log("\n--keep: 片付けない"); return; }
    const { data: pk } = await sb.from("property_pickups").select("id").like("batch_id", "YUMA_auto_%");
    const ids = ((pk ?? []) as Array<{ id: number }>).map((r) => r.id);
    const { data: factsAfter } = await sb.from("property_sheet_facts").select("id, wants_judged").limit(5000);
    const created = ((factsAfter ?? []) as Array<{ id: number }>).filter((r) => !beforeIds.has(r.id)).map((r) => r.id);
    if (created.length) { const d = await sb.from("property_sheet_facts").delete().in("id", created).select("id"); log(`property_sheet_facts ${(d.data ?? []).length}行（テストで増えた分）を消した`); }
    let restored = 0;
    const beforeMap = new Map(((factsBefore ?? []) as Array<{ id: number; wants_judged: unknown }>).map((r) => [r.id, r.wants_judged]));
    for (const r of (factsAfter ?? []) as Array<{ id: number; wants_judged: unknown }>) {
      if (!beforeMap.has(r.id)) continue;
      if (JSON.stringify(beforeMap.get(r.id) ?? null) === JSON.stringify(r.wants_judged ?? null)) continue;
      await sb.from("property_sheet_facts").update({ wants_judged: beforeMap.get(r.id) ?? null }).eq("id", r.id);
      restored++;
    }
    log(`property_sheet_facts の wants_judged を ${restored}行 実行前に戻した`);
    if (ids.length) { const d = await sb.from("property_pickups").delete().in("id", ids).select("id"); log(`property_pickups ${(d.data ?? []).length}行を消した`); }
    const { data: cs } = await sb.from("property_customers").select("id").in("customer_name", ["YUMA_AUTO_TEST_A", "YUMA_AUTO_TEST_B"]);
    const cids = ((cs ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (cids.length) { const d = await sb.from("property_customers").delete().in("id", cids).select("id"); log(`テスト顧客 ${(d.data ?? []).length}人を消した`); }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
