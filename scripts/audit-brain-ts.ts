// analyzed_msg_ts はどちらの列で欠けているか（読み取りのみ）
// 2026-09-20 竹内「ブレインの判断通りにうごくか、ちゃんと AIX-META わたされているか」
//   audit-brain-handoff.ts で「判断も action もあるのに analyzed_msg_ts が無いだけで古い扱い」が
//   330件中 101件（30.6%）出た。書き込み側（brain-core: analyzed_msg_ts = lastCustomerMsg.created_at）と
//   合成（mergeBrainLayers は { ...fresh } なので保持）は正しかったので、どの列で欠けるかを分けて数える。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const { data } = await sb.from("conversations")
    .select("id, customer_name, status, suggested_aix_meta, last_brain_meta, ai_draft, brain_analyzed_at")
    .order("updated_at", { ascending: false }).limit(400);
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const has = (m: unknown, k: string) => !!(m && typeof m === "object" && (m as Record<string, unknown>)[k]);

  let sugg = 0, suggTs = 0, suggAction = 0;
  let last = 0, lastTs = 0, lastAction = 0;
  let shownDraft = 0, shownDraftLastTs = 0;
  const samples: string[] = [];
  for (const r of rows) {
    const s = r.suggested_aix_meta, l = r.last_brain_meta;
    if (s) { sugg++; if (has(s, "analyzed_msg_ts")) suggTs++; if (has(s, "action")) suggAction++; }
    if (l) { last++; if (has(l, "analyzed_msg_ts")) lastTs++; if (has(l, "action")) lastAction++; }
    // 画面が下書きを表示すると suggested は消える（__SHOWN__）。その時 last_brain_meta が控え
    if (String(r.ai_draft ?? "") === "__SHOWN__") {
      shownDraft++;
      if (has(l, "analyzed_msg_ts")) shownDraftLastTs++;
    }
    if (!s && l && has(l, "action") && !has(l, "analyzed_msg_ts") && samples.length < 8) {
      samples.push(`  ${r.customer_name} [${r.status}] draft=${String(r.ai_draft ?? "").slice(0, 12)} last.action=${(l as Record<string, unknown>).action}`);
    }
  }
  const p = (n: number, d: number) => d ? `${((n / d) * 100).toFixed(1)}%` : "-";
  console.log(`=== 会話 ${rows.length}件 ===\n`);
  console.log(`suggested_aix_meta がある : ${sugg}件`);
  console.log(`   うち analyzed_msg_ts あり: ${suggTs}件 (${p(suggTs, sugg)})`);
  console.log(`   うち action あり         : ${suggAction}件 (${p(suggAction, sugg)})`);
  console.log(`\nlast_brain_meta がある    : ${last}件`);
  console.log(`   うち analyzed_msg_ts あり: ${lastTs}件 (${p(lastTs, last)})   ← ここが低いと控えが使えない`);
  console.log(`   うち action あり         : ${lastAction}件 (${p(lastAction, last)})`);
  console.log(`\n下書きを表示済み（ai_draft=__SHOWN__）: ${shownDraft}件`);
  console.log(`   その時 last_brain_meta に ts あり  : ${shownDraftLastTs}件 (${p(shownDraftLastTs, shownDraft)})`);
  if (samples.length) {
    console.log(`\n--- suggested が無く last に action はあるが ts が無い（鮮度が分からず捨てられる）---`);
    for (const s of samples) console.log(s);
  }

  // ── どの経路が書いた判断で ts が欠けるか（source / analysis_mode 別）──
  const bySrc = new Map<string, { n: number; ts: number; keys: Set<string> }>();
  for (const r of rows) {
    const s = r.suggested_aix_meta as Record<string, unknown> | null;
    if (!s || typeof s !== "object") continue;
    const src = String(s.source ?? s.analysis_mode ?? s.decision_source ?? "(印なし)");
    if (!bySrc.has(src)) bySrc.set(src, { n: 0, ts: 0, keys: new Set() });
    const c = bySrc.get(src)!;
    c.n++;
    if (s.analyzed_msg_ts) c.ts++;
    for (const k of Object.keys(s)) c.keys.add(k);
  }
  console.log(`\n=== suggested_aix_meta を書いた経路別の ts 充足 ===`);
  for (const [src, c] of [...bySrc.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(c.n).padStart(3)}件  ts あり ${String(c.ts).padStart(3)}件 (${p(c.ts, c.n)})  source=${src}`);
    if (c.ts / c.n < 0.6) console.log(`        持っている項目: ${[...c.keys].slice(0, 14).join(", ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
