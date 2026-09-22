// ナレッジの引き方を category ごとの枠に変えると、何が引かれるようになるかを実物で比べる（読み取りのみ）
//
// 2026-09-23 竹内「①おこなう（category ごとに枠を分けて引く）／importance をさげたら質落ちるからしない」
//
// 旧: match_reply_knowledge          … 距離順に LIMIT するだけ（長い category が枠を独占）
// 新: match_reply_knowledge_balanced … category ごとに上限（per_category）を設ける
//
// 実データの「お客様の発言」で両方を引いて、
//   ① category の内訳がどう変わるか
//   ② 引かれる中身が実際に変わるか（実物を目で読む）
//   ③ 会社として答えが決まっている事（緊急連絡先・店舗）の正解が入るようになるか
// を見る。⚠ importance の線は両方とも同じにして、変えたのが「枠」だけであることを保つ。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-knowledge-balanced.ts [N=6] [PER_CAT=4]
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });
type Hit = { id: string; content: string | null; category: string | null; importance: number | null; similarity: number | null };

/** 実データから採った「答えが1つに決まる事を聞かれた場面」＋普通の場面 */
const QUERIES: string[] = (process.env.QUERIES ?? [
  "緊急連絡先は必ず必要ですか？",
  "当日はそちらの店舗へ伺い、ご相談させていただきながら、ほかの物件もご紹介いただければと思います",
  "これ室内写真欲しいです",
  "敷金ありだと件数は増えますか？",
  "スーモに乗ってるやつしか案内できないですか？自分で調べてみて見てみたいところがあるのですが",
  "エリアこのままで家賃10〜11で2LDKで探せますか？",
].join("|")).split("|");

async function main() {
  const MIN_IMP = Number(process.env.MIN_IMP ?? 8);
  const COUNT = Number(process.env.COUNT ?? 12);
  const PER_CAT = Number(process.env.PER_CAT ?? 4);
  console.log(`min_importance=${MIN_IMP}（変えない）／ match_count=${COUNT} ／ per_category=${PER_CAT}\n`);

  const catOld = new Map<string, number>(), catNew = new Map<string, number>();
  let changedTotal = 0, pairs = 0;
  for (const q of QUERIES) {
    const emb = (await openai.embeddings.create({ model: "text-embedding-3-small", input: q })).data[0].embedding;
    const [oldR, newR] = await Promise.all([
      sb.rpc("match_reply_knowledge", { query_embedding: emb, match_count: COUNT, min_importance: MIN_IMP, boost_state: null }),
      sb.rpc("match_reply_knowledge_balanced", { query_embedding: emb, match_count: COUNT, min_importance: MIN_IMP, boost_state: null, per_category: PER_CAT }),
    ]);
    const o = (oldR.data ?? []) as Hit[], n = (newR.data ?? []) as Hit[];
    if (oldR.error) { console.log(`旧RPCエラー: ${oldR.error.message}`); return; }
    if (newR.error) { console.log(`新RPCエラー: ${newR.error.message}`); return; }
    for (const h of o) catOld.set(h.category ?? "-", (catOld.get(h.category ?? "-") ?? 0) + 1);
    for (const h of n) catNew.set(h.category ?? "-", (catNew.get(h.category ?? "-") ?? 0) + 1);
    const oldIds = new Set(o.map((h) => h.id));
    const fresh = n.filter((h) => !oldIds.has(h.id));
    changedTotal += fresh.length; pairs++;

    console.log(`${"═".repeat(74)}\n■ 「${q.slice(0, 44)}」`);
    console.log(`  旧: ${o.map((h) => `${h.category}`).join(" ")}`);
    console.log(`  新: ${n.map((h) => `${h.category}`).join(" ")}`);
    console.log(`  新しく入った ${fresh.length}件:`);
    for (const h of fresh.slice(0, 4)) {
      console.log(`    [${String(h.category).padEnd(16)} imp=${h.importance} 類似=${(h.similarity ?? 0).toFixed(3)}] ${String(h.content ?? "").replace(/\s+/g, " ").slice(0, 78)}`);
    }
    const dropped = o.filter((h) => !new Set(n.map((x) => x.id)).has(h.id));
    if (dropped.length) {
      console.log(`  押し出された ${dropped.length}件（本当に要らない物か目で読む）:`);
      for (const h of dropped.slice(0, 3)) {
        console.log(`    [${String(h.category).padEnd(16)} imp=${h.importance} 類似=${(h.similarity ?? 0).toFixed(3)}] ${String(h.content ?? "").replace(/\s+/g, " ").slice(0, 78)}`);
      }
    }
  }
  console.log(`\n${"═".repeat(74)}\n【category の内訳（${pairs}問の合計）】`);
  const cats = [...new Set([...catOld.keys(), ...catNew.keys()])];
  for (const c of cats.sort((a, b) => (catNew.get(b) ?? 0) - (catNew.get(a) ?? 0))) {
    console.log(`   ${c.padEnd(18)} 旧 ${String(catOld.get(c) ?? 0).padStart(3)} → 新 ${String(catNew.get(c) ?? 0).padStart(3)}`);
  }
  console.log(`\n   1問あたり平均 ${(changedTotal / Math.max(pairs, 1)).toFixed(1)}件 入れ替わった（${COUNT}件中）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
