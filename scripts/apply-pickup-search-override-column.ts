// property_pickups.search_override を本番DBに作る（migrate-schema/route.ts と同じ DDL）
// 2026-09-27 竹内「案Aでおこなう」: メモの上書きで検索した回は判定もその上書きで（その回をどの上書きで判定したかの印）
// 実行: npx tsx --env-file=.env.local scripts/apply-pickup-search-override-column.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS search_override JSONB;`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const a = await sb.from("property_pickups").select("id, search_override").limit(1);
  console.log("select property_pickups.search_override:", a.error ? `NG ${a.error.message}` : "OK");
})();
