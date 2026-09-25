// scripts/yuma-star-rank-test.ts
// 🌟（物件ピックアップの一番オススメ）を DeepSeek で付け直し、旧の前置きと新しい前置き（2026-09-25 任務B）で何が変わるかを見る。
//   材料は本番の売上サポ（property_pickups）に残っている実物の資料 PDF。お客様の条件の文は拡張と同じ形（buildCustomerConditionsString・名前と電話番号は入らない）。
//   DB に書くのは DeepSeek の費用の記録（llm_usage_logs action=property_rank）だけ。LINE・会話には何も送らない。
//   同じ新しい前置きを2回呼んで、前置きキャッシュ（cache_read）が効くかも見る。
// 実行: npx tsx --env-file=.env.local scripts/yuma-star-rank-test.ts [--batches=3]
import { createClient } from "@supabase/supabase-js";
import { enrichSummariesFromPdf, buildRankPrompt, buildRankMaterials, parseRankReply } from "../app/lib/pickup-rank";
import { buildCustomerConditionsString } from "./audit-condition-coverage";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
type Row = Record<string, any>;

/** 2026-09-25 より前の前置き（比べる用の写し） */
function oldRankPrompt(summaries: string[], customerConditions?: string | null): string {
  const conditionsBlock = customerConditions ? `【お客様の希望条件（最優先で照らし合わせること）】\n${customerConditions}\n\n` : "";
  return `以下の物件一覧を見て、お客様に最もオススメの物件番号（1始まり）を選んでください。上位1〜3件をJSONで返してください。JSONのみ返すこと。

${conditionsBlock}判断基準（優先順位が高い順）:
1. お客様希望条件への合致度（最優先）:
   - 家賃が希望予算以内か
   - 間取りが希望と一致するか
   - 徒歩分数が希望以内か
   - 専有面積が希望以上か
   - 敷・礼が0ヶ月に近いほど良い（なし > 1ヶ月 > 2ヶ月以上）
   ※ 予算を大幅に超える・希望外間取りの物件は絶対に選ばないこと
2. AD（弊社の報酬・条件に合う物件の中では最も重視する）:
   - 「AD 2ヶ月」「AD 200%」以上 = 家賃×2ヶ月分以上の報酬（1 を満たす物件の中では必ず最上位に置く。3ヶ月以上ならさらに上）
   - 「AD 1ヶ月」「AD 100%」 = 家賃×1ヶ月分の報酬（AD なしより上）
   - 「AD 50,000円」のような円は家賃で割って月数に直す
   - AD記載なし = 報酬ゼロ（他の条件が同じなら AD ありを上に）
3. ㎡あたりの家賃（安いほど良い）
4. 間取りと面積の広さ（2LDK>1LDK>1DK>1K>1R、かつ㎡数が大きいほど良い）
5. 駅からの徒歩分数（近いほど良い）

${summaries.join('\n\n')}

例: {"recommended":[2,5]}`;
}

async function rank(prompt: string, tag: string): Promise<{ nums: number[] | null; model: string | null; hit: number; miss: number; ms: number }> {
  const { callDeepSeek, VISION_ALT_MODEL_DEFAULT } = await import("../app/lib/vision-alt-provider");
  const { recordAltUsage } = await import("../app/lib/llm-usage-recorder");
  const t0 = Date.now();
  // --mode=nothink: 推論なし（thinking:false・本番と同じ 2026-09-25〜）／ 既定は旧の推論 low。--max=: 出力の上限（推論込み）
  const MODE = arg("mode") ?? "think"; const MAX = Number(arg("max") ?? "4000");
  const res = await callDeepSeek(null, prompt, MODE === "nothink" ? { maxTokens: 300, timeoutMs: 30_000, thinking: false, temperature: 0 } : { maxTokens: MAX, timeoutMs: 90_000, effort: "low" });
  const nums = res ? parseRankReply(res.text) : null;
  await recordAltUsage({
    model: res?.model ?? VISION_ALT_MODEL_DEFAULT, action: "property_rank", conversationId: "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", // YUMA（テストの費用だと分かるように）
    usage: { input_tokens: res?.usage.cacheMiss ?? 0, output_tokens: res?.usage.output ?? 0, cache_read_input_tokens: res?.usage.cacheHit ?? 0 },
    status: res ? 200 : 0, errorType: res ? (nums ? null : "empty_or_unparsable") : "no_response",
    durationMs: Date.now() - t0, sysHead: `【🌟 順位付け・YUMAテスト ${tag}】` + prompt.slice(0, 80), sysKeyFull: null, maxTokens: 4000,
  });
  return { nums, model: res?.model ?? null, hit: res?.usage.cacheHit ?? 0, miss: res?.usage.cacheMiss ?? 0, ms: Date.now() - t0 };
}

async function main() {
  const nB = Number(arg("batches") ?? "3");
  const { data } = await sb.from("property_pickups").select("id, batch_id, property_customer_id, rank, summary_text, pdf_blob_url, recommended, score").not("property_customer_id", "is", null).order("id");
  const batches = new Map<string, Row[]>();
  for (const r of (data ?? []) as Row[]) { if (!batches.has(r.batch_id)) batches.set(r.batch_id, []); batches.get(r.batch_id)!.push(r); }
  const picked = [...batches.values()].filter((rs) => rs.length >= 3).slice(0, nB);
  for (const rs of picked) {
    const { data: c } = await sb.from("property_customers").select("rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, other_requests, ng_points, pet, move_in_time, desired_area, floor_area_min").eq("id", rs[0].property_customer_id).maybeSingle();
    const cond = buildCustomerConditionsString(c as Record<string, unknown> | null);
    const b64 = await Promise.all(rs.map(async (r) => { try { return Buffer.from(await (await fetch(r.pdf_blob_url)).arrayBuffer()).toString("base64"); } catch { return null; } }));
    // 🌟 と🧠の行を外し、番号を付け直す（本番の merge-pdfs の順位付けの前の形）
    const base = rs.map((r, i) => String(r.summary_text).replace(/^【\d+[^】]*】/u, `【${i + 1}】`).replace(/\n🧠[\s\S]*$/u, ""));
    const summaries = await enrichSummariesFromPdf(base, b64, "yuma-star");
    const materials = await buildRankMaterials(b64);
    console.log(`\n######## 回 ${String(rs[0].batch_id).slice(0, 36)}（${rs.length}件）条件: ${cond ?? "（なし）"}`);
    summaries.forEach((s, i) => console.log(`  【${i + 1}】id ${rs[i].id} ${s.split("\n").slice(0, 1).join("").replace(/^【\d+】/, "")} / ${s.split("\n").slice(1).join(" / ")}\n        資料: ${materials[i] ?? "（なし）"}`));
    const o = arg("skipold") ? { nums: null, model: "skip", hit: 0, miss: 0, ms: 0 } : await rank(oldRankPrompt(summaries, cond), "旧");
    const n1 = await rank(buildRankPrompt(summaries, cond, materials), "新");
    const n2 = await rank(buildRankPrompt(summaries, cond, materials), "新2回目");
    const ids = (ns: number[] | null) => (ns ?? []).map((k) => `【${k}】id ${rs[k - 1]?.id ?? "?"}`).join(" > ") || "（答えなし）";
    console.log(`  旧の前置き: ${ids(o.nums)}  （${o.model} ${o.ms}ms 入力 hit ${o.hit}/miss ${o.miss}）`);
    console.log(`  新の前置き: ${ids(n1.nums)}  （${n1.model} ${n1.ms}ms 入力 hit ${n1.hit}/miss ${n1.miss}）`);
    console.log(`  新・2回目 : ${ids(n2.nums)}  （${n2.model} ${n2.ms}ms 入力 hit ${n2.hit}/miss ${n2.miss}）`);
  }
}

main().then(() => new Promise((r) => setTimeout(r, 4000))).catch((e) => { console.error(e); process.exit(1); }); // 費用の記録（非同期）を書き終えてから終わる
