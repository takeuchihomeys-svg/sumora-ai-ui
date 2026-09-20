// scripts/audit-knowledge-mask.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-knowledge-mask.ts [--show=25]
//
// 2026-09-19 竹内（慶次事例）「ナレッジの部分から進める。テスト行いながら改善」:
//   maskKnowledgeSpecifics を ai_reply_knowledge 全件に当てて、
//   ①何件が変わるか ②言い回しの型が壊れていないか を目で読む（設計知見「過去の全件に当てる」）。
// 読み取りのみ（DB は書き換えない。伏せるのはプロンプトに入れる直前）。
import { createClient } from "@supabase/supabase-js";
import { maskKnowledgeSpecifics } from "../app/lib/knowledge-placeholder";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const show = Number(arg("show", "25"));

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("ai_reply_knowledge")
      .select("id, category, content, used_count, apply_count, correct_count, wrong_count, conversation_state")
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    rows.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  const changed: Array<{ r: Record<string, unknown>; before: string; after: string }> = [];
  const byCat: Record<string, number> = {};
  for (const r of rows) {
    const res = maskKnowledgeSpecifics(String(r.content ?? ""), String(r.category ?? ""));
    if (!res.changed) continue;
    changed.push({ r, before: String(r.content ?? ""), after: res.text });
    byCat[String(r.category ?? "")] = (byCat[String(r.category ?? "")] ?? 0) + 1;
  }
  console.log(`=== 全 ${rows.length}件のうち、伏せる対象: ${changed.length}件（${((100 * changed.length) / rows.length).toFixed(1)}%）===`);
  Object.entries(byCat).forEach(([k, v]) => console.log(`  ${k}: ${v}件`));

  // 効き目: wrong の多い物がどれだけ直るか
  const wrongSum = changed.reduce((s, c) => s + Number(c.r.wrong_count ?? 0), 0);
  const applySum = changed.reduce((s, c) => s + Number(c.r.apply_count ?? 0), 0);
  console.log(`\n  伏せる対象の合計: apply ${applySum} / wrong ${wrongSum}（wrong 率 ${((100 * wrongSum) / Math.max(applySum, 1)).toFixed(1)}%）`);

  console.log(`\n=== 変換の中身（使われた順 ${show}件・言い回しの型が壊れていないか目で読む）===`);
  changed.sort((a, b) => Number(b.r.used_count ?? 0) - Number(a.r.used_count ?? 0)).slice(0, show).forEach((c, i) => {
    console.log(`\n[${i + 1}] used=${c.r.used_count} apply=${c.r.apply_count} wrong=${c.r.wrong_count} state=${c.r.conversation_state}`);
    console.log(`  旧: ${c.before.replace(/\n/g, " / ").slice(0, 170)}`);
    console.log(`  新: ${c.after.replace(/\n/g, " / ").slice(0, 170)}`);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
