// scripts/nightly-scene-tree.ts — #804 の大きな地図の木を毎晩数え直す（#687・費用0・LLM なし・2026-11-27 作業員A）
//   入力: audit-scene-branches.ts --tree-out の json（今夜の広げの json から最初の1回）。前の晩の写しと比べ、一番弱い節を1つ選ぶ。
//   --write: quality_daily に tree:* を書き、今夜の木の写しを .claude/exam-cache/conductor-marks/scene-tree-<日>.json に残す（次の晩の前の晩になる）。
//            SCENE_TREE_LEDGER=on の時だけ、一番弱い節を台帳（work_items・origin=found_gap）に持ち主つきで積む（既定 off・記録だけから・題で重ねない）
//   実行: npx tsx --env-file=.env.local scripts/nightly-scene-tree.ts --tree=<json> [--prev=<json>] [--write]
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { summarizeTree, weakestNode, nightLines, weakestLedgerRow, type TreeJson } from "./lib/scene-tree-nightly";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const write = process.argv.includes("--write");
const MARKS = join(__dirname, "..", "..", "..", "..", ".claude", "exam-cache", "conductor-marks");
const day = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);

async function main() {
  const treePath = arg("tree");
  if (!treePath) throw new Error("--tree=<audit-scene-branches の --tree-out の json> が要る");
  const cur = JSON.parse(readFileSync(treePath, "utf8")) as TreeJson;
  // 前の晩: --prev か、写しの一番新しい物（今日より前）
  let prevPath = arg("prev");
  if (!prevPath && existsSync(MARKS)) { const xs = readdirSync(MARKS).filter((f) => /^scene-tree-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < `scene-tree-${day}.json`).sort(); if (xs.length) prevPath = join(MARKS, xs[xs.length - 1]); }
  const prev = prevPath && existsSync(prevPath) ? (JSON.parse(readFileSync(prevPath, "utf8")) as TreeJson) : null;
  const cs = summarizeTree(cur), ps = prev ? summarizeTree(prev) : null;
  const w = weakestNode(cs, ps);
  console.log(nightLines(cs, ps, w).join("\n"));
  if (!write) return;
  if (!existsSync(MARKS)) mkdirSync(MARKS, { recursive: true });
  writeFileSync(join(MARKS, `scene-tree-${day}.json`), JSON.stringify(cur));
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });
  const rows = [
    { metric: "tree:agree", value: cs.agreePct, n: cs.dense }, { metric: "tree:advance", value: cs.advancePct, n: cs.nodes },
    { metric: "tree:dead_end_nogoal", value: cs.deadNoGoal.length, n: cs.nodes }, { metric: "tree:dead_end_unknown", value: cs.deadUnknown, n: cs.nodes },
    { metric: "tree:return_back", value: cs.returnPct, n: cs.returnN },
  ].map((r) => ({ day, scope: "takeuchi", source: "scripts/nightly-scene-tree.ts", ...r, ...(r.metric === "tree:agree" && w ? { detail: { weakest: w } } : {}) }));
  const { error } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
  console.log(error ? `quality_daily: ${error.message}` : `quality_daily ${rows.length}行・写し scene-tree-${day}.json`);
  if (w && (process.env.SCENE_TREE_LEDGER ?? "").trim().toLowerCase() === "on") {
    const { addFoundGaps } = await import("./lib/found-gap-ledger");
    const added = await addFoundGaps(sb as never, [weakestLedgerRow(w)], "nightly-scene-tree");
    console.log(added.length ? `台帳に足した: #${added.join("・#")}` : "台帳: 同じ題が開いている（足さない）");
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
