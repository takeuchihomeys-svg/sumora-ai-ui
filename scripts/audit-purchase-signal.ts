// scripts/audit-purchase-signal.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-purchase-signal.ts
//
// 2026-09-20 竹内「ブレインがここの部分強化して、ここなら申込になりそうなお客さんだと分析して、
//   そこから申込の流れにいく形はどうか」:
//   仕組みは既にある（purchase_signal_level: none/soft/strong/peak・engagement_stance: push/wait・
//   applying_pattern 由来の P5）。**効いているか**を実データで測る。
//   設計知見「材料やルールを足す前に、届き方・鮮度・費用を測って構造を直す」
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const APPLIED = ["applying", "application_push", "screening", "closed_won"];

async function main() {
  // ① いま各会話が持っているブレインの判断（suggested_aix_meta）から購買シグナルを集める
  const convs: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("conversations")
      .select("id, customer_name, status, suggested_aix_meta, brain_strategy, updated_at, created_at")
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    convs.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  console.log(`=== 会話 ${convs.length}件 ===`);

  const sig = (c: Record<string, unknown>) => {
    const m = c.suggested_aix_meta as Record<string, unknown> | null;
    return (m?.purchase_signal_level as string | null) ?? "(なし)";
  };
  const stance = (c: Record<string, unknown>) => {
    const m = c.suggested_aix_meta as Record<string, unknown> | null;
    return (m?.engagement_stance as string | null) ?? "(なし)";
  };

  const dist: Record<string, number> = {};
  for (const c of convs) dist[sig(c)] = (dist[sig(c)] ?? 0) + 1;
  console.log(`\n--- purchase_signal_level の分布（今の判断）---`);
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(10)} ${String(v).padStart(4)}件`));

  const dist2: Record<string, number> = {};
  for (const c of convs) dist2[stance(c)] = (dist2[stance(c)] ?? 0) + 1;
  console.log(`\n--- engagement_stance の分布 ---`);
  Object.entries(dist2).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(10)} ${String(v).padStart(4)}件`));

  // ② シグナル × 今の状態（申込に到達しているか）
  console.log(`\n--- 購買シグナル × 今の状態（申込フェーズ以降に到達しているか）---`);
  console.log(`  ${"シグナル".padEnd(10)} ${"件数".padStart(5)} ${"申込以降".padStart(8)} ${"率".padStart(6)}`);
  for (const level of ["peak", "strong", "soft", "none", "(なし)"]) {
    const rs = convs.filter((c) => sig(c) === level);
    if (rs.length === 0) continue;
    const applied = rs.filter((c) => APPLIED.includes(String(c.status ?? ""))).length;
    console.log(`  ${level.padEnd(10)} ${String(rs.length).padStart(5)} ${String(applied).padStart(8)} ${`${((100 * applied) / rs.length).toFixed(0)}%`.padStart(6)}`);
  }

  // ③ 申込以降に到達した会話が、そこに至る前にどのシグナルだったか（brain_decision_logs の履歴）
  const { data: logs } = await sb.from("brain_decision_logs")
    .select("conversation_id, suggested_action, conversation_status, created_at, digest, matched, actual_aix_type")
    .order("created_at", { ascending: false }).limit(1000);
  console.log(`\n--- brain_decision_logs ${logs?.length ?? 0}件（digest に購買シグナルが残っているか）---`);
  const withSig = (logs ?? []).filter((l) => /purchase|signal|peak|strong/i.test(String(l.digest ?? "")));
  console.log(`  digest に購買シグナルらしき語: ${withSig.length}件`);
  if (withSig.length) console.log(`  例: ${String(withSig[0].digest).slice(0, 200)}`);
  else console.log(`  例（digest の中身）: ${String((logs ?? [])[0]?.digest ?? "").slice(0, 250)}`);

  // ④ 申込に到達した会話の「申込の直前に押された AIX」
  const appliedConvs = convs.filter((c) => APPLIED.includes(String(c.status ?? "")));
  console.log(`\n--- 申込以降に到達した会話 ${appliedConvs.length}件 ---`);
  const beforeApply: Record<string, number> = {};
  for (const c of appliedConvs.slice(0, 60)) {
    const { data: aix } = await sb.from("aix_usage_logs")
      .select("aix_type, created_at").eq("conversation_id", c.id as string)
      .not("sent_at", "is", null).order("created_at", { ascending: true }).limit(30);
    const list = (aix ?? []).map((a) => String(a.aix_type));
    const idx = list.findIndex((t) => t === "application_push" || t === "application_confirm");
    const prev = idx > 0 ? list[idx - 1] : idx === 0 ? "(申込が最初)" : list[list.length - 1] ?? "(AIXなし)";
    beforeApply[prev] = (beforeApply[prev] ?? 0) + 1;
  }
  console.log(`  申込の1つ前に押された AIX（最大60会話）:`);
  Object.entries(beforeApply).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k.padEnd(28)} ${v}件`));
}
main().catch((e) => { console.error(e); process.exit(1); });
