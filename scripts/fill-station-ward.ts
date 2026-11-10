// scripts/fill-station-ward.ts
// 2026-11-10 竹内さん「SUPABASE のデータベースの部分との連携はちゃんとできているのか」→ 点検で見つかった欠けを埋める
//
// station_map の ward（駅が属する区）が空の駅を、拡張の正本（popup-maps.js の STATION_WARD_MAP）から補完する。
//   読み: chrome-extension/popup-maps.js の STATION_WARD_MAP（正本）
//   書き: station_map.ward（空の行だけ。既にある値は触らない）
//
// 使い方:
//   npx tsx --env-file=.env.local scripts/fill-station-ward.ts          # 見るだけ（何が変わるか）
//   npx tsx --env-file=.env.local scripts/fill-station-ward.ts --apply  # 実行
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import vm from "vm";

const APPLY = process.argv.includes("--apply");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
);

function loadWardMap(): Record<string, string> {
  const p = path.join(process.cwd(), "chrome-extension", "popup-maps.js");
  const src = fs.readFileSync(p, "utf8");
  // popup-maps.js は `const STATION_WARD_MAP = {...};` の形。`const` は VM の context に載らないので、
  //   その定義の所だけを式にして評価する（6行目〜145行目・{...} の対応で切る）。
  const start = src.indexOf("const STATION_WARD_MAP = {");
  if (start < 0) return {};
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) return {};
  const body = src.slice(i, end);
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  const out = vm.runInContext("(" + body + ")", ctx);
  return (out ?? {}) as Record<string, string>;
}

async function main() {
  const wardOf = loadWardMap();
  console.log("正本の駅→区:", Object.keys(wardOf).length, "件");

  const rows: Array<{ id: string; token: string; ward: string | null }> = [];
  for (let from = 0; from < 1200; from += 500) {
    const { data, error } = await sb.from("station_map").select("id,token,ward").range(from, from + 499);
    if (error) { console.error("読めません:", error.message); process.exit(1); }
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 500) break;
  }
  console.log("station_map:", rows.length, "行");

  const empty = rows.filter((r) => !r.ward);
  console.log("区が空:", empty.length, "行");

  const fillable = empty.filter((r) => wardOf[r.token]);
  const unfillable = empty.filter((r) => !wardOf[r.token]);
  console.log(`  埋められる（正本にある）: ${fillable.length}`);
  console.log(`  埋められない（正本にも無い）: ${unfillable.length}`);
  for (const r of fillable.slice(0, 30)) console.log(`    ${r.token} → ${wardOf[r.token]}`);
  if (unfillable.length) {
    console.log("  正本にも無い駅（先頭20）:", unfillable.slice(0, 20).map((r) => r.token).join(", "));
  }

  if (!APPLY) {
    console.log("\n※ 見るだけです。実行するには --apply を付けてください");
    return;
  }
  let ok = 0, ng = 0;
  for (const r of fillable) {
    const { error } = await sb.from("station_map").update({ ward: wardOf[r.token] }).eq("id", r.id).is("ward", null);
    if (error) { ng++; console.warn(`  ✗ ${r.token}: ${error.message}`); } else ok++;
  }
  console.log(`\n補完: ${ok}行 成功 / ${ng}行 失敗`);
}

main().catch((e) => { console.error(e); process.exit(1); });
