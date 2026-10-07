// scripts/kb-curate.ts — 設計知見の整理を手元で回す（週1の cron /api/cron/design-knowledge と同じ関数 runDesignKnowledgeCycle）
// 2026-10-06 竹内「設計知見が学んだことは更新されていっているのか。設計知見の更新や成長はツールを完成させるにあたってかなり重要」（⑯）
//   ① 重複（題が同じ・本文 0.9 以上）と ② 竹内さんの決定で古くなった行（DECISIONS の auto）だけ自動で退役（消さない・理由と上書きした行を残す）
//   ③ 似ている組は DeepSeek に関係を聞いて要確認の一覧へ（自動では退役しない）④ 分野ごとのまとめを作り memory/rules_digest_*.md に写す
// 実行: npx tsx --env-file=.env.local scripts/kb-curate.ts            … 数えるだけ（DB に書かない・LLM なし）
//       npx tsx --env-file=.env.local scripts/kb-curate.ts --apply --llm [--since-days=7]  … 退役・DeepSeek・まとめ・memory に写す
//       npx tsx --env-file=.env.local scripts/kb-curate.ts --llm --write-review  … DB に書かず、要確認（食い違い・同じ・段・札）だけ memory/rules_digest_review.md に写す（2026-10-07）
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { runDesignKnowledgeCycle } from "../app/lib/design-knowledge-curation-server";
import { keepPriorityBlock, writeDigestFiles } from "./kb-digest";
import { writeFileSync } from "node:fs";

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
  console.log(`   埋め込み: ${r.embed.embedded}行（$${r.embed.usd.toFixed(4)}）・似ている組の候補: 埋め込み ${r.candidates.embedding}・文字の重なり ${r.candidates.lexical}`);
  if (r.plannedSame?.length) { console.log(`   確かな同じ（近さ 0.95 以上・DeepSeek same）: ${r.plannedSame.length}（退役 ${r.retiredSame ?? 0}）`); for (const p of r.plannedSame) console.log(`   - ${p.id} → ${p.supersededBy}  ${p.reason}`); }
  if (r.candidates.scene) console.log(`   同じ場面の決まり同士の組（P0/P1）: ${r.candidates.scene}`);
  if (r.tags) { console.log(`   札の正規化: ${r.tags.planned}行（当てた ${r.tags.applied}）`); for (const x of r.tags.examples) console.log(`   - ${x}`); }
  if (r.priority) {
    const c = r.priority.counts;
    console.log(`   段: P0 ${c[0]}・P1 ${c[1]}・P2 ${c[2]}・P3 ${c[3]}（列 ${r.priority.column ? "あり" : "まだ無い＝推定"}・付け直し ${r.priority.fixesPlanned}／当てた ${r.priority.fixesApplied}）`);
    for (const w of r.priority.warnings) console.log(`   ⚠ ${w}`);
  }
  console.log(`④ まとめ:${r.digests.map((d) => `${d.area} ${d.rows}`).join("・")}`);
  if (apply) for (const f of await writeDigestFiles(join(process.cwd(), "memory"))) console.log("   書きました:", f);
  // 2026-10-07 --write-review: DB に書かずに（dry でも）要確認の一覧を memory/rules_digest_review.md に写す（段の要確認の塊は残す）
  else if (process.argv.includes("--write-review") && r.reviewMd) { const f = join(process.cwd(), "memory", "rules_digest_review.md"); writeFileSync(f, keepPriorityBlock(f, r.reviewMd)); console.log("   書きました:", f); }
})().catch((e) => { console.error(e); process.exit(1); });
