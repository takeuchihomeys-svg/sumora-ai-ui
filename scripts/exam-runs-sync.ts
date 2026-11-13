// 試験の統括（exam-conductor）の**過去の結果**を DB（exam_runs）に流し込む。
//
// 2026-11-13 竹内さん「試験の統括と拡張ツールとデータベースの連携の部分をちゃんとできるようにする」
//
// これまで: 結果は `memory/exam-brain/conductor/*.result.json` の**手元のファイルだけ**だった。
// → ここで全部 DB に移す（1回だけ流せばよい。新しい回は exam-brain が自動で入れる）。
//
// 実行:
//   npx tsx --env-file=.env.local scripts/exam-runs-sync.ts            # 何が入るか見るだけ
//   npx tsx --env-file=.env.local scripts/exam-runs-sync.ts --apply    # DB に入れる
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { execFileSync } from "child_process";
import { toExamRun, upsertExamRun, summarizeExamRuns, type ExamRunRow } from "../app/lib/exam-runs";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);
/**
 * 2026-11-13: 結果の置き場は**手元のキャッシュ**（`.claude/exam-cache/exam-brain/conductor`）。
 *   `scripts/lib/llm-cassette.ts` の `examCacheRoot` と同じ決め方（git の共通フォルダの下）。
 *   ⚠ ここを間違えると「0件」になる（実際に最初は `memory/...` を見て0件だった）。
 */
function examCacheRoot(): string {
  const e = String(process.env.EXAM_CACHE_DIR ?? "").trim();
  if (e) return e;
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return join(dirname(common), ".claude", "exam-cache");
  } catch { return join(process.cwd(), "scripts", ".exam-cache"); }
}
const CONDUCTOR_DIR = join(examCacheRoot(), "exam-brain", "conductor");
const apply = process.argv.includes("--apply");

(async () => {
  if (!existsSync(CONDUCTOR_DIR)) {
    console.log("統括の結果フォルダがありません:", CONDUCTOR_DIR);
    return;
  }
  // *.result.json を全部読む（計画 *.plan.json は候補数を拾うのに使う）
  const files = readdirSync(CONDUCTOR_DIR).filter((f) => f.endsWith(".result.json"));
  console.log(`■ 手元の結果ファイル: ${files.length}件`);

  const rows: ExamRunRow[] = [];
  let skipped = 0;
  for (const f of files) {
    let local: Record<string, unknown> | null = null;
    try { local = JSON.parse(readFileSync(join(CONDUCTOR_DIR, f), "utf8")) as Record<string, unknown>; }
    catch { skipped++; continue; }
    // 計画（同じ label の .plan.json）から候補数・材料を拾う
    let plan: { candidates?: unknown; material?: unknown } | null = null;
    const label = typeof local.label === "string" ? local.label : f.replace(/\.result\.json$/, "");
    const planPath = join(CONDUCTOR_DIR, `${label}.plan.json`);
    if (existsSync(planPath)) {
      try { plan = JSON.parse(readFileSync(planPath, "utf8")) as { candidates?: unknown; material?: unknown }; } catch { plan = null; }
    }
    const row = toExamRun(local as never, plan);
    if (row) rows.push(row);
    else skipped++;
  }
  console.log(`■ DBに入れる形: ${rows.length}件（読めない・label 無し: ${skipped}件）`);

  const s = summarizeExamRuns(rows);
  console.log("\n■ 傾向（これが「統括の強化」の材料）:");
  console.log(`  回数 ${s.runs}・合格 ${s.pass}/${s.total}（${s.pass_rate == null ? "-" : Math.round(s.pass_rate * 100) + "%"}）`);
  console.log(`  費用の合計 $${s.cost_total}・平均 $${s.cost_avg ?? "-"}・LLM ${s.llm_calls}回`);
  console.log("  よく落ちる所（上位5）:");
  s.top_misses.slice(0, 5).forEach((m) => console.log(`    ・${m.id} … ${m.n}回${m.why ? "（" + m.why + "）" : ""}`));

  if (!apply) {
    console.log("\n（--apply を付けると DB の exam_runs に入れます）");
    return;
  }
  let ok = 0, ng = 0;
  for (const row of rows) {
    const r = await upsertExamRun(sb as never, row);
    if (r.ok) ok++; else { ng++; if (ng <= 3) console.log(`  NG ${row.label}: ${r.error}`); }
  }
  console.log(`\n■ DBへ: 入れた ${ok}件・失敗 ${ng}件`);
  if (ng) console.log("  ⚠ 表が無い時は migrate-schema（または /api/admin/run-sql）で exam_runs を作ってから流し直してください");
})();
