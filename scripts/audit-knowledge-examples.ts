// scripts/audit-knowledge-examples.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-knowledge-examples.ts [--word=ペット] [--limit=30]
//
// 2026-09-19 竹内（慶次事例）「ナレッジの部分から進める」:
//   ai_reply_knowledge の本文に**他のお客様の発言・具体条件**が埋まっていないかを洗い出す。
//   慶次さんの「ペット可条件で」は、ナレッジの principle の例（「あと、ペット可能でお願いします」）が
//   実際の条件と取り違えられて出た。
// 読み取りのみ。出力は個人情報を含むので共有しない。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const word = arg("word");
const limit = Number(arg("limit", "30"));

/** お客様が言う種類の具体条件語（これが例として本文に埋まっていると、実際の条件と取り違えられる） */
const COND_WORDS = ["ペット", "駐車場", "オートロック", "独立洗面", "バストイレ別", "宅配ボックス", "ウォークインクローゼット", "楽器", "事務所", "二人入居", "ルームシェア", "同棲", "喫煙", "角部屋", "分譲", "ガスコンロ"];
/** 他顧客の発言がそのまま埋まっている形 */
const QUOTED_UTTERANCE_RE = /(?:顧客|お客様|客)(?:が|は)?\s*[「『][^」』]{6,120}[」』]|例[:：]\s*[「『][^」』]{6,120}[」』]|[「『][^」』]{6,120}(?:お願いします|欲しいです|ほしいです|できますか|可能でしょうか|でお願い)[」』]/;

async function main() {
  const { count: total } = await sb.from("ai_reply_knowledge").select("id", { count: "exact", head: true });
  console.log(`=== ai_reply_knowledge 全 ${total} 件 ===\n`);

  // ① カテゴリ別の件数
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("ai_reply_knowledge")
      .select("id, category, content, conversation_state, importance, used_count, hypothesis_status, source")
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    rows.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  const byCat: Record<string, number> = {};
  for (const r of rows) byCat[String(r.category ?? "(null)")] = (byCat[String(r.category ?? "(null)")] ?? 0) + 1;
  console.log("--- カテゴリ別 ---");
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));

  // ② 他顧客の発言が埋まっている件数
  const quoted = rows.filter((r) => QUOTED_UTTERANCE_RE.test(String(r.content ?? "")));
  console.log(`\n--- 他のお客様の発言がそのまま埋まっている: ${quoted.length}件（${((100 * quoted.length) / Math.max(rows.length, 1)).toFixed(1)}%）---`);

  // ③ 具体条件語が例として入っている件数（語ごと）
  console.log(`\n--- 具体条件語が本文に入っている（実際の条件と取り違えられる）---`);
  const byWord: Array<{ w: string; n: number }> = [];
  for (const w of COND_WORDS) {
    const n = rows.filter((r) => String(r.content ?? "").includes(w)).length;
    if (n > 0) byWord.push({ w, n });
  }
  byWord.sort((a, b) => b.n - a.n).forEach(({ w, n }) => console.log(`  ${w.padEnd(20)} ${n}件`));

  // ④ 指定の語の中身を出す（1つずつ直すため）
  if (word) {
    const hits = rows.filter((r) => String(r.content ?? "").includes(word));
    console.log(`\n=== 「${word}」を含むナレッジ ${hits.length}件（1つずつ読む）===`);
    hits.slice(0, limit).forEach((r, i) => {
      console.log(`\n[${i + 1}] id=${r.id}`);
      console.log(`  category=${r.category} state=${r.conversation_state} importance=${r.importance} used=${r.used_count} status=${r.hypothesis_status} source=${r.source}`);
      console.log(`  ${String(r.content ?? "").replace(/\n/g, "\n  ")}`);
    });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
