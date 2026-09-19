// scripts/audit-condition-expansion.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-expansion.ts [--days=365]
//
// 2026-09-19 竹内（タマキ事例）。設計知見「落とす仕組みを入れたら過去の下書き全部に当てて何が変わるかを目で読む」。
// ① detectConditionExpansion を お客様の発言 全件に当てて、拾った件数と中身を見る（誤爆の確認）
// ② fixExpansionLimiting を 過去の AI 下書き（aix_generate_log）に当てて、何行が書き換わるかを見る
// 読み取りのみ。出力は個人情報を含むので共有しない。
import { createClient } from "@supabase/supabase-js";
import { detectConditionExpansion } from "../app/lib/condition-expansion";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
if (!url || !key) { console.error("環境変数が読めません（NEXT_PUBLIC_SUPABASE_URL / KEY）"); process.exit(1); }
const sb = createClient(url, key);

const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=365").split("=")[1]);
const since = new Date(Date.now() - days * 86400_000).toISOString();

/** 会話の文からエリアらしい語を粗く拾う（監査用の目安。本番は route.ts の AREA_SUFFIX_RE を使う） */
const AREA_RE = /[一-龥ァ-ヶa-zA-Z0-9]{1,10}(?:駅|区|市|町|村|沿線|線)/g;

async function main() {
  // ── ① お客様の発言に当てる ───────────────────────────────────────────────
  let from = 0; const size = 1000;
  let total = 0, hit = 0, vague = 0;
  const samples: string[] = [];
  const vagueSamples: string[] = [];
  for (;;) {
    const { data, error } = await sb.from("messages")
      .select("text")
      .eq("sender", "customer").gte("created_at", since).not("text", "is", null)
      .range(from, from + size - 1);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    for (const r of data) {
      const t = (r.text as string) ?? "";
      if (!t.trim()) continue;
      total++;
      const v = detectConditionExpansion(t);
      if (!v.expanded) continue;
      hit++;
      if (v.vague) { vague++; if (vagueSamples.length < 12) vagueSamples.push(t.replace(/\n/g, " / ").slice(0, 100)); }
      else if (samples.length < 25) samples.push(t.replace(/\n/g, " / ").slice(0, 100));
    }
    if (data.length < size) break;
    from += size;
  }
  console.log(`\n=== ① お客様の発言（${days}日・${total}件） ===`);
  console.log(`追加・許容と判定: ${hit}件（${(100 * hit / Math.max(total, 1)).toFixed(2)}%）／うち行き先が曖昧: ${vague}件`);
  console.log(`\n--- 拾った文（先頭25件・誤爆が無いか目で読む） ---`);
  samples.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s}`));
  console.log(`\n--- 行き先が曖昧（エリア名を書かせない）---`);
  vagueSamples.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s}`));

  // ② 出口の決定論（「〇〇周辺全域から」→「〇〇も含めて」）は入れない。
  //    2026-09-19 に一度作って過去の下書き1,000件に当てたら、書き換わった92件が**全部改悪**だった
  //    （既存条件のエリアの限定まで直してしまう／「エリアより新着物件」のような文が壊れる）。
  //    詳しくは app/lib/condition-expansion.ts の「【やらない判断】」を参照。
}
main().catch((e) => { console.error(e); process.exit(1); });
