/**
 * 点検: migrate-schema に書いてあるのに、**本番DBに無い**列・表を洗い出す（読み取りのみ・変更しない）。
 *
 * なぜ要るか（2026-11-13 竹内さん「なんで連携できていないのか」）:
 *   `migrate-schema/route.ts` に DDL を書いたのに**本番DBには当たっていない**列があった
 *   （`shot_b64`・`shot_learn`・`shot_in_db`）。コードは「ある前提」で書かれているので、
 *   読み取りが落ちる → 静かに学習が止まる、という形で表面化していた。
 *
 * 実行: npx tsx --env-file=.env.local scripts/check-db-columns.ts
 */
import { supabase } from "../app/lib/supabase-server";

type Need = { table: string; cols: string[] };

const NEED: Need[] = [
  {
    table: "human_motion_learn",
    cols: [
      "id", "created_at", "install_id", "device_label", "site", "mode", "ext_version",
      "ops", "sessions", "gap_ms", "moves_n", "move_speed_px_s", "move_curve", "move_ms", "move_dist",
      "drag_n", "points_n", "point_x", "point_y", "point_fields", "scrolls_n", "scroll_dy", "scroll_y",
      "kinds", "fields", "field_order",
      "shot_taken", "shot_key", "shot_w", "shot_h",
      // ↓ ここが本番で欠けていた（2026-11-13 実測）
      "shot_b64", "shot_in_db", "shot_ops", "shot_learn",
    ],
  },
  {
    table: "human_learn_profile",
    cols: ["id", "created_at", "scope", "source_rows", "source_from", "source_to", "ext_version", "bundle", "lines", "read_count"],
  },
  {
    table: "exam_runs",
    cols: ["id", "created_at", "label", "ran_at", "plan_label", "candidates", "compare", "next_actions", "triage", "llm", "llm_calls", "cost_usd", "summary"],
  },
];

async function main() {
  const missing: Array<{ table: string; col: string; err: string }> = [];
  const missingTables = new Set<string>();

  for (const need of NEED) {
    // 表そのものがあるか（1列だけ読む）
    const t = await supabase.from(need.table).select("id").limit(1);
    if (t.error && /relation|does not exist|schema cache/i.test(t.error.message) && /relation/i.test(t.error.message)) {
      missingTables.add(need.table);
      console.log(`\n❌ 表がありません: ${need.table}  → ${t.error.message}`);
      continue;
    }
    console.log(`\n■ ${need.table}`);
    for (const c of need.cols) {
      const r = await supabase.from(need.table).select(c).limit(1);
      if (r.error) {
        missing.push({ table: need.table, col: c, err: r.error.message });
        console.log(`  ❌ ${c}  … ${r.error.message}`);
      } else {
        console.log(`  ✅ ${c}`);
      }
    }
  }

  console.log("\n===== まとめ =====");
  if (missingTables.size) console.log("無い表: " + Array.from(missingTables).join(", "));
  const byTable = new Map<string, string[]>();
  for (const m of missing) {
    if (!byTable.has(m.table)) byTable.set(m.table, []);
    byTable.get(m.table)!.push(m.col);
  }
  if (!byTable.size && !missingTables.size) console.log("全部そろっています（欠けなし）");
  for (const table of missingTables) {
    console.log(`無い表: ${table}（表ごと作る必要があります・migrate-schema の DDL を当ててください）`);
  }
  for (const [table, cols] of byTable) {
    if (missingTables.has(table)) continue;
    console.log(`無い列: ${table} … ${cols.join(", ")}`);
    const typeOf = (c: string) =>
      /_b64$/.test(c) ? "TEXT"
        : /^shot_in_db$/.test(c) ? "BOOLEAN NOT NULL DEFAULT false"
          : "JSONB";
    console.log("  " + cols.map((c) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${c} ${typeOf(c)};`).join("\n  "));
  }
  process.exit(missingTables.size || missing.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
