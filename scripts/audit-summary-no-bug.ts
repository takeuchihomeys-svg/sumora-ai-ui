// 説明文の番号【N】が物件名に残っていないか（読み取りのみ）
//
// 2026-09-21 除外の純関数を書いていて見つけた:
//   merge-pdfs は物件名を取り出す時 `/^【\d+🌟?★?】\s*/` で番号を剥がしているが、
//   **🌟 はサロゲートペア**なので `u` フラグの無い `🌟?` は「前半は必須・後半は任意」になり、
//   **🌟 が付いていない「【1】」には当たらない**。
//   ＝ 🌟 が付かない物件（=オススメに選ばれなかった大多数）の名前が「【1】〇〇」のまま保存される。
//
// 設計知見「本文から名前を拾う正規表現は…絵文字を入れるなら u フラグ」と同じ踏み方。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-summary-no-bug.ts
import { createClient } from "@supabase/supabase-js";
import { SUMMARY_NO_RE } from "../app/lib/sent-property-filter";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
/** merge-pdfs にあった（u フラグ無しの）形 */
const BUGGY = /^【\d+🌟?★?】\s*/;

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("sent_properties")
      .select("property_name, room_no, source, sent_at")
      .order("sent_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; rows.push(...r); if (r.length < 1000) break;
  }
  console.log(`=== sent_properties ${rows.length}件 ===\n`);

  const dirty = rows.filter((r) => /^【\s*\d+/.test(String(r.property_name ?? "")));
  console.log(`=== 物件名の先頭に番号【N】が残っている行 ===`);
  console.log(`   ${dirty.length}件（${pct(dirty.length, rows.length)}）`);
  const bySource = new Map<string, number>();
  for (const r of dirty) bySource.set(String(r.source ?? "-"), (bySource.get(String(r.source ?? "-")) ?? 0) + 1);
  for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${s.padEnd(28)} ${n}件`);
  console.log(`\n   ─ 例 ─`);
  for (const r of dirty.slice(0, 8)) console.log(`     ${String(r.property_name)}`);

  console.log(`\n=== 直した正規表現なら剥がせるか ===`);
  let fixed = 0, stillBad = 0;
  for (const r of dirty) {
    const n = String(r.property_name);
    if (SUMMARY_NO_RE.test(n)) fixed++; else stillBad++;
  }
  console.log(`   u フラグ付きで剥がせる: ${fixed}件 ／ それでも残る: ${stillBad}件`);
  console.log(`   （壊れていた形 BUGGY で剥がせたのは ${dirty.filter((r) => BUGGY.test(String(r.property_name))).length}件）`);

  console.log(`\n=== 影響 ===`);
  console.log(`   物件名が「【1】〇〇」だと、次に同じ物件を送った時の突き合わせで別物になる。`);
  console.log(`   ＝ 重複の警告も、これから作る除外も当たらない。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
