// 一時: 9/30 の 2.5.47 で別のお客様に付いた ITANDI の候補を、写しを取ってから外す（竹内さん 9/30「A外す」・コミットしない）
//   実行: npx tsx --env-file=.env.local scripts/tmp-cleanup-misattached.ts <写しの保存先.json> [--apply]
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
// [id の範囲, 付いていたお客様の id の頭（この人の行だけ外す）]
const RANGES: Array<[number, number, string]> = [[2131, 2180, "e6c7f775"]];
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
    const { data, error } = await sb.from("property_pickups").select("*").gte("id", lo).lte("id", hi).eq("site", "realpro").eq("status", "pending").is("sent_at", null);
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
