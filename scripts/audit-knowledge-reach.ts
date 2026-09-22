// ナレッジ（ai_reply_knowledge）が返信生成まで届いているかを測る（読み取りのみ）
//
// 2026-09-23 竹内「返信セットされる質の部分のこと、ここが後々自動返信にきりかえていくから
//   セットされる文の質を上げる必要がある」
//
// 【きっかけ】通常返信で大幅に書き直された実物を読むと、AI が会社として答えの決まっている事を
//   その場で作文していた:
//     お客様「緊急連絡先は必ず必要ですか？」
//       AI「基本的には必要となりますが、物件・保証会社によって柔軟に対応頂けるケースもございます」
//       実送信「お申込みするにあたり緊急連絡先様は必須となります！！お母様、お父様など3親等以内の方で」
//     お客様「当日はそちらの店舗へ伺い」
//       AI「当日は中央区周辺全域からご希望条件に合ったお部屋もあわせてご紹介させて頂きます」
//       実送信「弊社オンライン専門の不動産サービスとなります！店舗では無く…」
//   どちらも**正解がナレッジに入っていた**のに使われていなかった（used_count=1 / 0）。
//
// 【測ること】
//   ① min_importance の線で何件が弾かれているか
//   ② category ごとの「通る率・長さ・実際に使われた率」
//   ③ 特定の語（社内ルール）について、正解のナレッジが引ける側にいるか
//
// 実行: npx tsx --env-file=.env.local scripts/audit-knowledge-reach.ts [MIN_IMP=8]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Kn = { category: string | null; importance: number | null; used_count: number | null; content: string | null; embedding: unknown };
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);

async function main() {
  // brain-core の match_reply_knowledge 呼び出しと同じ線
  const MIN_IMP = Number(process.env.MIN_IMP ?? 8);
  const rows: Kn[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("ai_reply_knowledge")
      .select("category, importance, used_count, content, embedding").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Kn[]; rows.push(...r); if (r.length < 1000) break;
  }
  console.log(`ナレッジ ${rows.length}件（brain-core は min_importance=${MIN_IMP} で引いている）\n`);

  const pass = rows.filter((r) => (r.importance ?? 0) >= MIN_IMP);
  console.log(`① 線を通るもの: ${pass.length}件（${pct(pass.length, rows.length)}）／ 埋め込みが無い: ${rows.filter((r) => !r.embedding).length}件`);
  console.log(`   一度でも使われた: ${rows.filter((r) => (r.used_count ?? 0) > 0).length}件（${pct(rows.filter((r) => (r.used_count ?? 0) > 0).length, rows.length)}）`);
  const byImp = new Map<number, number>();
  for (const r of rows) byImp.set(r.importance ?? 0, (byImp.get(r.importance ?? 0) ?? 0) + 1);
  console.log(`\n   importance 別:`);
  for (const [i, n] of [...byImp].sort((a, b) => b[0] - a[0])) {
    console.log(`     imp=${String(i).padStart(2)}: ${String(n).padStart(5)}件 ${i >= MIN_IMP ? "通る" : "**弾かれる**"}`);
  }

  console.log(`\n② category 別（ここに偏りが出る）`);
  console.log(`   ${"category".padEnd(18)} ${"件数".padStart(5)} ／ 線を通る ／ 平均の長さ ／ 実際に使われた率`);
  const cats = [...new Set(rows.map((r) => r.category ?? "-"))]
    .sort((a, b) => rows.filter((r) => (r.category ?? "-") === b).length - rows.filter((r) => (r.category ?? "-") === a).length);
  for (const c of cats.slice(0, 10)) {
    const xs = rows.filter((r) => (r.category ?? "-") === c);
    const p = xs.filter((r) => (r.importance ?? 0) >= MIN_IMP).length;
    const len = Math.round(xs.reduce((a, r) => a + String(r.content ?? "").length, 0) / Math.max(xs.length, 1));
    console.log(`   ${String(c).padEnd(18)} ${String(xs.length).padStart(5)} ／ ${pct(p, xs.length).padStart(7)} ／ ${String(len).padStart(5)}字 ／ ${pct(xs.filter((r) => (r.used_count ?? 0) > 0).length, xs.length).padStart(7)}`);
  }

  console.log(`\n③ 社内ルールの正解は引ける側にいるか（実物を読む）`);
  const WORDS = (process.env.WORDS ?? "3親等,オンライン専門,店舗,緊急連絡先").split(",");
  for (const w of WORDS) {
    const hit = rows.filter((r) => String(r.content ?? "").includes(w));
    if (hit.length === 0) { console.log(`\n   「${w}」: 0件`); continue; }
    const p = hit.filter((r) => (r.importance ?? 0) >= MIN_IMP);
    console.log(`\n   「${w}」 ${hit.length}件 ／ 線を通る ${p.length}件（${pct(p.length, hit.length)}）`);
    for (const r of hit.sort((a, b) => (b.used_count ?? 0) - (a.used_count ?? 0)).slice(0, 4)) {
      console.log(`     imp=${r.importance ?? "-"} used=${String(r.used_count ?? 0).padStart(4)} ${String(r.category ?? "-").padEnd(16)} ${(r.importance ?? 0) >= MIN_IMP ? "通る  " : "弾かれる"} ${String(r.content ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
