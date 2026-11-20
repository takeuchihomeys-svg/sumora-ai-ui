// scripts/build-playbook.ts — 最新の学習の束から「動き方の手順書」を作って保存する（DB は読むだけ・1行）
// 実行: npx tsx --env-file=.env.local scripts/build-playbook.ts [--scope=all|realpro|itandi|reins]
//   出力: scripts/_playbook/playbook-<scope>-<時刻>.json と、画面に要約・検査結果（統括Pro に渡す材料）
//   ⚠ DB には書かない・拡張にも配らない（配り方は竹内さんの OK の後）。
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { buildPlaybook, checkPlaybook } from "../app/lib/action-playbook";

const scopeArg = (process.argv.find((a) => a.startsWith("--scope=")) || "").replace("--scope=", "") || "all";
const SCOPES = ["all", "realpro", "itandi", "reins"];
if (!SCOPES.includes(scopeArg)) { console.error(`--scope は ${SCOPES.join("/")} のどれか`); process.exit(1); }

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

(async () => {
  const r = await sb.from("human_learn_profile")
    .select("id, created_at, bundle")
    .eq("scope", scopeArg)
    .order("created_at", { ascending: false })
    .limit(1);
  if (r.error) { console.error("束を読めません:", r.error.message); process.exit(1); }
  const row = (r.data ?? [])[0] as { id: number; created_at: string; bundle: Record<string, unknown> } | undefined;
  if (!row || !row.bundle) { console.error(`束が1件もありません（scope=${scopeArg}）`); process.exit(1); }

  const pb = buildPlaybook(row.bundle as Parameters<typeof buildPlaybook>[0]);
  const issues = checkPlaybook(pb);
  const dir = path.join(process.cwd(), "scripts", "_playbook");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `playbook-${scopeArg}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ scope: scopeArg, from_bundle_id: row.id, from_bundle_at: row.created_at, playbook: pb, issues }, null, 2), "utf8");

  console.log(`■ 手順書（${scopeArg}）の版: ${pb.version}（作り方 v${pb.build_v}・束 ${row.id}・${row.created_at}）`);
  console.log(`押す位置: solid ${pb.points.solid}・thin ${pb.points.thin}／押すと開く欄 ${pb.opens_known}`);
  for (const s of pb.scenes) {
    const v = s.variants > 0 ? `・順番${s.variants}通り（値を含む数）` : "・順番の数は束に無い";
    console.log(`■ ${s.label}（${s.confidence}・検索${s.runs}回・操作${s.ops}${v}）: ${s.steps.join(" > ")}`);
  }
  for (const g of pb.gaps) console.log(`⚠ ${g}`);
  console.log(issues.length ? `■ 検査: ${issues.length}件\n  ${issues.join("\n  ")}` : "■ 検査: 問題なし（この検査で見つかる範囲）");
  console.log(`保存: ${path.relative(process.cwd(), file)}`);
})().catch((e) => { console.error(e); process.exit(1); });
