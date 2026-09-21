// 物件名の先頭に残った【N】を剥がす（既定は下見だけ・--apply で書き込み）
//
// 2026-09-21 除外の純関数を書いていて見つけたバグの後始末。
//   merge-pdfs が `/^【\d+🌟?★?】\s*/`（u フラグ無し）で番号を剥がしていたため、
//   **🌟 が付かない物件**の名前が「【5】エスリード新北野」のまま保存されていた。
//   実測: sent_properties 18,149件中 **14,746件（81.2%）**。
//
// 名前が違えば突き合わせは当たらないので、重複の警告も除外も効かない。
// 番号は「その送信の何番目か」でしかなく、物件を指す情報ではないので落としてよい。
//
// 実行:
//   npx tsx --env-file=.env.local scripts/fix-sent-property-names.ts           # 下見（何も書かない）
//   npx tsx --env-file=.env.local scripts/fix-sent-property-names.ts --apply   # 実行
import { createClient } from "@supabase/supabase-js";
import { SUMMARY_NO_RE } from "../app/lib/sent-property-filter";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLY = process.argv.includes("--apply");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

async function main() {
  const rows: Array<{ id: string; property_name: string }> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("sent_properties")
      .select("id, property_name")
      .like("property_name", "【%")
      .order("sent_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(`⚠ ${error.message}`); process.exit(1); }
    const r = (data ?? []) as Array<{ id: string; property_name: string }>;
    if (r.length === 0) break; rows.push(...r); if (r.length < 1000) break;
  }
  console.log(`=== 先頭が「【」の行 ${rows.length}件 ===\n`);

  const plan = rows.map((r) => ({ id: r.id, from: r.property_name, to: r.property_name.replace(SUMMARY_NO_RE, "").trim() }))
    .filter((x) => x.to && x.to !== x.from);
  const unchanged = rows.length - plan.length;
  console.log(`   直す ${plan.length}件（${pct(plan.length, rows.length)}）／ 触らない ${unchanged}件`);
  console.log(`   ⚠ 触らない分は「【」で始まるが番号ではない名前（そのまま残す）\n`);

  console.log(`   ─ 直す例（目で読む・設計知見「件数だけ見ない」）─`);
  for (const x of plan.slice(0, 12)) console.log(`     ${x.from}  →  ${x.to}`);
  // ⚠ 最初は「2文字以下」を危ないと見なしたが、目で読んだら「雅苑」「桜荘」は**正しい物件名**だった
  //   （設計知見「件数だけ見ない・目で読む」）。止めるのは本当に名前でない物だけにする。
  const weird = plan.filter((x) => !x.to || /^\d+$/.test(x.to));
  if (weird.length) {
    console.log(`\n   ⚠ 直した後が空・数字だけ: ${weird.length}件`);
    for (const x of weird.slice(0, 8)) console.log(`     ${x.from}  →  ${x.to}`);
  } else {
    console.log(`\n   ✅ 直した後が空・数字だけになる行は 0件`);
  }
  // 名前として使えない「物件」（拡張が名前を取れなかった時の既定値）は数えて出すだけ
  const placeholder = plan.filter((x) => x.to === "物件");
  if (placeholder.length) {
    console.log(`   （拡張が名前を取れず「物件」になっている行: ${placeholder.length}件。`
      + `号室も URL も無ければ外す判断には使われないのでそのまま直す）`);
  }

  if (!APPLY) {
    console.log(`\n   下見だけで終わり。書き込むなら --apply を付ける`);
    return;
  }
  if (weird.length > 0) {
    console.error(`\n   ⚠ 直した後がおかしい行があるので止める（${weird.length}件）`);
    process.exit(1);
  }
  let done = 0;
  for (let i = 0; i < plan.length; i += 100) {
    const chunk = plan.slice(i, i + 100);
    await Promise.all(chunk.map((x) => sb.from("sent_properties").update({ property_name: x.to }).eq("id", x.id)));
    done += chunk.length;
    if (done % 1000 === 0 || done === plan.length) console.log(`   ${done}/${plan.length}`);
  }
  console.log(`\n   ${done}件を直しました`);
}
main().catch((e) => { console.error(e); process.exit(1); });
