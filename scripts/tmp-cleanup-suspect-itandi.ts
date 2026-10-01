// 一時: 9/28・9/30 昼のずれの疑いの ITANDI の束（竹内さん 10/01「A」＝ITANDI の18束だけ・リアプロの3束は残す）を、写しを取ってから外す（竹内さん 9/30「A外す」・コミットしない）
//   実行: npx tsx --env-file=.env.local scripts/tmp-cleanup-misattached.ts <写しの保存先.json> [--apply]
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
// [id の範囲, 付いていたお客様の id の頭（この人の行だけ外す）]
const RANGES: Array<[number, number, string]> = [
  [838, 840, "42a89f52"], [841, 856, "42a89f52"], [857, 873, "42a89f52"], [901, 912, "42a89f52"], [949, 956, "42a89f52"],
  [983, 990, "42a89f52"], [1045, 1051, "42a89f52"], [1056, 1058, "42a89f52"], [1743, 1746, "42a89f52"],
  [1986, 2005, "04e88194"], [2210, 2217, "893ee6e9"], [2222, 2222, "893ee6e9"], [2246, 2250, "b54f8c23"],
  [2262, 2273, "c4d4fc07"], [2275, 2276, "893ee6e9"], [2277, 2278, "04c3b455"],
];
const _OLD: Array<[number, number, string]> = [
  [2343, 2360, "382d4296"],
  [2368, 2401, "382d4296"],
  [2426, 2440, "458cbd41"],
  [2471, 2475, "42a89f52"],
  [2485, 2497, "587503e4"],
  [2509, 2549, "458cbd41"],
  [2552, 2566, "4d51caa5"],
  [2575, 2596, "5e0c6539"],
];
async function main() {
  const out = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!out) { console.error("写しの保存先を指定"); process.exit(1); }
  const all: Array<Record<string, unknown>> = [];
  for (const [lo, hi, pc] of RANGES) {
    const { data, error } = await sb.from("property_pickups").select("*").gte("id", lo).lte("id", hi).eq("site", "itandi").eq("status", "pending").is("sent_at", null);
    if (error) { console.error(error.message); process.exit(1); }
    const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((r) => String(r.property_customer_id).startsWith(pc));
    console.log(`${lo}-${hi} ${pc}: ${rows.length}件`);
    all.push(...rows);
  }
  if (!apply || !fs.existsSync(out)) fs.writeFileSync(out, JSON.stringify(all));
  console.log(`写し ${all.length}件 → ${out}`);
  if (!apply) { console.log("（--apply なし: 外していない）"); return; }
  const ids = all.map((r) => r.id as number);
  for (let i = 0; i < ids.length; i += 100) {
    const { error, count } = await sb.from("property_pickups").delete({ count: "exact" }).in("id", ids.slice(i, i + 100)).eq("status", "pending").is("sent_at", null);
    if (error) { console.error("外せない:", error.message); process.exit(1); }
    console.log(`外した ${count}件`);
  }
}
main();
