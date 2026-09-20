// scripts/audit-knowledge-used.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-knowledge-used.ts
//
// 2026-09-19 竹内「ナレッジの部分から進める。1つずつ改善する」:
//   11,080件を全部直すのは現実的でないので、**実際にプロンプトに届いているもの**に絞る。
//   使われた回数・最後に使われた日・仮説の状態で分け、その中で問題のある本文を出す。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const COND_WORDS = ["ペット", "駐車場", "オートロック", "独立洗面", "バストイレ別", "宅配ボックス", "ウォークインクローゼット", "楽器", "事務所", "二人入居", "ルームシェア", "同棲", "喫煙", "角部屋", "分譲", "ガスコンロ"];
const QUOTED_RE = /(?:顧客|お客様|客)(?:が|は)?\s*[「『][^」』]{6,120}[」』]|例[:：]\s*[「『][^」』]{6,120}[」』]/;

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("ai_reply_knowledge")
      .select("id, category, title, content, conversation_state, importance, used_count, last_used_at, apply_count, correct_count, wrong_count, hypothesis_status, source, created_at")
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    rows.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  const n = (r: Record<string, unknown>, k: string) => Number(r[k] ?? 0);
  const used = rows.filter((r) => n(r, "used_count") > 0);
  const applied = rows.filter((r) => n(r, "apply_count") > 0);
  console.log(`=== 全 ${rows.length}件 ===`);
  console.log(`  使われた（used_count>0）: ${used.length}件`);
  console.log(`  当てられた（apply_count>0）: ${applied.length}件`);

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[String(r.hypothesis_status ?? "(null)")] = (byStatus[String(r.hypothesis_status ?? "(null)")] ?? 0) + 1;
  console.log(`\n--- hypothesis_status 別 ---`);
  Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));

  // 使われた物の中で問題のある本文
  const bad = used.filter((r) => {
    const c = String(r.content ?? "");
    return QUOTED_RE.test(c) || COND_WORDS.some((w) => c.includes(w));
  }).sort((a, b) => n(b, "used_count") - n(a, "used_count"));
  console.log(`\n=== 使われた物のうち、他顧客の発言か具体条件語が入っている: ${bad.length}件 ===`);
  bad.slice(0, 25).forEach((r, i) => {
    const hitWords = COND_WORDS.filter((w) => String(r.content ?? "").includes(w));
    console.log(`\n[${i + 1}] used=${r.used_count} apply=${r.apply_count} correct=${r.correct_count} wrong=${r.wrong_count} cat=${r.category} state=${r.conversation_state} imp=${r.importance}`);
    console.log(`    id=${r.id}  語: ${hitWords.join("・") || "（引用のみ）"}`);
    console.log(`    ${String(r.content ?? "").replace(/\n/g, " / ").slice(0, 230)}`);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
