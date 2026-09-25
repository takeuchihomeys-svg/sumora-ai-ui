// AIXツール（2026-09-25 竹内）の本番DB:
//   ① property_pickups.seen_at / seen_by（新着物件の既読・スタッフ全員で共有）＋ 未読の「通す」の部分インデックス
//   ② automation_commands の status に 'cancelled' を許す（既存の不具合: /api/automation/stop・拡張の見送りが書けていなかった）
// migrate-schema/route.ts と同じ DDL。
// 実行: npx tsx --env-file=.env.local scripts/apply-aix-tool-new-arrivals.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const STMTS = [
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;`,
  `ALTER TABLE property_pickups ADD COLUMN IF NOT EXISTS seen_by TEXT;`,
  `CREATE INDEX IF NOT EXISTS idx_property_pickups_unseen ON property_pickups(created_at DESC) WHERE seen_at IS NULL AND verdict = 'pass' AND status = 'pending';`,
  `ALTER TABLE automation_commands DROP CONSTRAINT IF EXISTS automation_commands_status_check;`,
  `ALTER TABLE automation_commands ADD CONSTRAINT automation_commands_status_check CHECK (status IN ('pending', 'running', 'done', 'error', 'cancelled'));`,
  `SELECT pg_notify('pgrst', 'reload schema');`,
];

(async () => {
  for (const sql of STMTS) {
    const { error } = await sb.rpc("exec_sql", { sql });
    console.log(error ? `NG ${error.message}` : "OK", sql.slice(0, 90));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const a = await sb.from("property_pickups").select("id, seen_at, seen_by").limit(1);
  console.log("select property_pickups.seen_at/seen_by:", a.error ? `NG ${a.error.message}` : "OK");
  // 'cancelled' が書けるか: 誰にも拾われない行（status=cancelled で入れる・payload.source=schema_check）を1行入れて、すぐ消す
  const ins = await sb.from("automation_commands")
    .insert({ command_type: "batch_property_search", customer_ids: [], sites: ["reins"], status: "cancelled", payload: { source: "schema_check" } })
    .select("id").maybeSingle();
  if (ins.error) console.log("status='cancelled' の書き込み: NG", ins.error.message);
  else {
    console.log("status='cancelled' の書き込み: OK");
    const del = await sb.from("automation_commands").delete().eq("id", (ins.data as { id: string }).id);
    console.log("確かめの行を消した:", del.error ? `NG ${del.error.message}` : "OK");
  }
})();
