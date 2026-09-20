// scripts/diag-applying-pattern.ts — applying_pattern が何かを実物で確かめる（読み取りのみ）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const { data, error } = await sb.from("ai_reply_knowledge")
    .select("id, title, content, conversation_state, importance, used_count, apply_count, correct_count, wrong_count, source, created_at")
    .eq("category", "applying_pattern").order("used_count", { ascending: false }).limit(60);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = data ?? [];
  console.log(`=== applying_pattern ${rows.length}件 ===`);

  // 状態・出所の分布
  const dist = (k: string) => {
    const d: Record<string, number> = {};
    for (const r of rows) d[String((r as Record<string, unknown>)[k] ?? "(null)")] = (d[String((r as Record<string, unknown>)[k] ?? "(null)")] ?? 0) + 1;
    return d;
  };
  console.log(`  state: ${JSON.stringify(dist("conversation_state"))}`);
  console.log(`  source: ${JSON.stringify(dist("source"))}`);
  const sum = (k: string) => rows.reduce((s, r) => s + Number((r as Record<string, unknown>)[k] ?? 0), 0);
  console.log(`  合計 used=${sum("used_count")} apply=${sum("apply_count")} correct=${sum("correct_count")} wrong=${sum("wrong_count")}`);
  console.log(`  作られた期間: ${rows.map((r) => String(r.created_at).slice(0, 10)).sort()[0]} 〜 ${rows.map((r) => String(r.created_at).slice(0, 10)).sort().slice(-1)[0]}`);

  // JSON の形か
  const jsonish = rows.filter((r) => String(r.content ?? "").trim().startsWith("{"));
  console.log(`  JSON の形: ${jsonish.length}件 / 文章: ${rows.length - jsonish.length}件`);

  // 中の項目（キー）を集める
  const keys: Record<string, number> = {};
  for (const r of jsonish) {
    try {
      const o = JSON.parse(String(r.content)) as Record<string, unknown>;
      for (const k of Object.keys(o)) keys[k] = (keys[k] ?? 0) + 1;
    } catch { /* 壊れた JSON は数えない */ }
  }
  console.log(`\n--- 中の項目 ---`);
  Object.entries(keys).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(28)} ${v}件`));

  console.log(`\n=== 実物（使われた順 2件）===`);
  rows.slice(0, 2).forEach((r, i) => {
    console.log(`\n[${i + 1}] used=${r.used_count} apply=${r.apply_count} correct=${r.correct_count} wrong=${r.wrong_count} state=${r.conversation_state}`);
    console.log(`  title=${r.title}`);
    const c = String(r.content ?? "");
    try {
      const o = JSON.parse(c) as Record<string, unknown>;
      for (const [k, v] of Object.entries(o)) console.log(`  [${k}] ${JSON.stringify(v).slice(0, 330)}`);
    } catch { console.log(`  ${c.slice(0, 600)}`); }
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
