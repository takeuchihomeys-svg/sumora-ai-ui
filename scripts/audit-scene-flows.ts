/**
 * 場面ごとの手順（所在地・条件・検索・物件の取得・次のページ）を実データで見る
 * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
 *   統括が弱い部分の学習を強化する」
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/audit-scene-flows.ts
 *   npx tsx --env-file=.env.local scripts/audit-scene-flows.ts --days=14 --site=realpro
 *
 * ⚠ 読むだけ（DBに書かない）。入れるのは欄の名前と操作の種類だけ（入力した中身は扱わない）。
 */
import { createClient } from "@supabase/supabase-js";
import { learnSceneFlows, findWeakScenes, describeSceneFlow, scenePlaybook, SCENE_JA, type FlowOp } from "../app/lib/learn-flow-steps";

const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const days = Number(argOf("days", "7"));
const site = argOf("site", "");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

void (async () => {
  const sb = createClient(url, key);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let q = sb
    .from("search_audits")
    .select("created_at,status,site,cause_key,area_mode,filled")
    .gte("created_at", since)
    .not("filled", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (site) q = q.eq("site", site);
  const { data, error } = await q;
  if (error) { console.log("読めません:", error.message); process.exitCode = 1; return; }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const runs: FlowOp[][] = [];
  for (const r of rows) {
    const f = r.filled as { ops?: FlowOp[] } | null;
    const ops = Array.isArray(f?.ops) ? f!.ops! : [];
    if (ops.length >= 2) runs.push(ops);
  }
  console.log(`点検の記録: ${rows.length}件（${days}日${site ? "・" + site : ""}）`);
  console.log(`押した順番がある回: ${runs.length}件\n`);
  if (!runs.length) { console.log("材料がありません（filled.ops が空）"); return; }

  const flows = learnSceneFlows(runs);
  console.log("■ 場面ごとの手順（人の実測）");
  for (const f of flows) console.log("  " + describeSceneFlow(f));

  console.log("\n■ 弱い場面（統括が強化する所）");
  const weak = findWeakScenes(flows);
  if (!weak.length) console.log("  （見つかりませんでした）");
  for (const w of weak) console.log(`  ・${SCENE_JA[w.scene]}：${w.why}\n      → ${w.next}`);

  const pb = scenePlaybook(flows);
  if (pb.length) {
    console.log("\n■ 自動に渡せる手順（教える形）");
    for (const p of pb) console.log(p.split("\n").map((l) => "  " + l).join("\n"));
  }

  /**
   * どこで止まった回が多いか（場面で見る）。
   *   ⚠ abandoned の回は `steps` が空でも `filled.ops` に**最後まで押した記録**が残っている。
   *     その最後の場面＝止まった場面の手がかり。
   */
  const stopAt: Record<string, number> = {};
  for (const r of rows) {
    const st = String(r.status ?? "");
    if (st === "finished") continue;
    const f = r.filled as { ops?: FlowOp[] } | null;
    const ops = Array.isArray(f?.ops) ? f!.ops! : [];
    if (!ops.length) { stopAt["(押した記録なし)"] = (stopAt["(押した記録なし)"] ?? 0) + 1; continue; }
    const last = learnSceneFlows([ops], { by: null })[0];
    const k = last ? SCENE_JA[last.scene] : "(不明)";
    stopAt[k] = (stopAt[k] ?? 0) + 1;
  }
  const finished = rows.filter((r) => String(r.status ?? "") === "finished").length;
  console.log(`\n■ 止まった回が多い場面（完走 ${finished} / ${rows.length}件）`);
  for (const [k, v] of Object.entries(stopAt).sort((a, b) => b[1] - a[1])) console.log(`  ${v}件  ${k}`);
})();
