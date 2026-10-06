// scripts/kb-curate.ts — 設計知見の整理を手元で回す（週1の cron /api/cron/design-knowledge と同じ関数 runDesignKnowledgeCycle）
// 2026-10-06 竹内「設計知見が学んだことは更新されていっているのか。設計知見の更新や成長はツールを完成させるにあたってかなり重要」（⑯）
//   ① 重複（題が同じ・本文 0.9 以上）と ② 竹内さんの決定で古くなった行（DECISIONS の auto）だけ自動で退役（消さない・理由と上書きした行を残す）
//   ③ 似ている組は DeepSeek に関係を聞いて要確認の一覧へ（自動では退役しない）④ 分野ごとのまとめを作り memory/rules_digest_*.md に写す
// 実行: npx tsx --env-file=.env.local scripts/kb-curate.ts            … 数えるだけ（DB に書かない・LLM なし）
//       npx tsx --env-file=.env.local scripts/kb-curate.ts --apply --llm [--since-days=7]  … 退役・DeepSeek・まとめ・memory に写す
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { runDesignKnowledgeCycle } from "../app/lib/design-knowledge-curation-server";
import { writeDigestFiles } from "./kb-digest";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const apply = process.argv.includes("--apply");
const llm = process.argv.includes("--llm");
const sinceArg = (process.argv.find((a) => a.startsWith("--since-days=")) ?? "").split("=")[1];

(async () => {
  const r = await runDesignKnowledgeCycle(sb, { dry: !apply, llm, sinceDays: sinceArg ? Number(sinceArg) : null, by: "kb-curate" });
  console.log(`=== 設計知見の整理（${apply ? "当てた" : "数えただけ"}）: ${r.rows}行・現行 ${r.current}`);
  console.log(`① 重複: ${r.plannedDuplicates.length}（退役 ${r.retiredDuplicates}）`);
  for (const p of r.plannedDuplicates) console.log(`   - ${p.id} → ${p.supersededBy}  ${p.reason}`);
  console.log(`② 竹内さんの決定で古くなった行: ${r.plannedDecisions.length}（退役 ${r.retiredDecisions}）`);
  for (const p of r.plannedDecisions) console.log(`   - ${p.id} → ${p.supersededBy}  ${p.reason}`);
  if (r.missingDecisionRows.length) console.log(`   決定の行が見つからない決定: ${r.missingDecisionRows.join("・")}`);
  console.log(`③ 要確認: ${r.review.length}（DeepSeek ${r.llm.calls}回・答えなし ${r.llm.failed}）`);
  for (const v of r.review) console.log(`   - [${v.kind}${v.relation ? ":" + v.relation : ""}] ${v.ids.map((x) => x.slice(0, 8)).join(" / ")}  ${v.note}`);
  console.log(`④ まとめ: ${r.digests.map((d) => `${d.area} ${d.rows}`).join("・")}`);
  if (apply) for (const f of await writeDigestFiles(join(process.cwd(), "memory"))) console.log("   書きました:", f);
})().catch((e) => { console.error(e); process.exit(1); });
