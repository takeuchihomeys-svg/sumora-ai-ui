// scripts/audit-feedback-auto-answer.ts — 待っている AI 質問を設計知見で自動で答える（prompt-candidate-gen の最初と同じ関数）を、DB に書かずに試して目で読む
//   10/08 竹内さん「自動的にする」。DeepSeek（推論なし・温度0・最大20問）＝1回 $0.01 未満。
// 実行: npx tsx --env-file=.env.local scripts/audit-feedback-auto-answer.ts [--max=20]
import { createClient } from "@supabase/supabase-js";
import { runFeedbackAutoAnswer } from "../app/lib/feedback-auto-answer-server";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const max = Number((process.argv.find((a) => a.startsWith("--max=")) ?? "").split("=")[1] || 20);
(async () => {
  const r = await runFeedbackAutoAnswer(sb, { dry: true, max, maxExamples: max });
  console.log(`対象 ${r.targets}・答えられる ${r.answered}・答えない ${r.notAnswerable}・失敗 ${r.failed}・aix_pattern を閉じる ${r.closedAixPattern}・DeepSeek ${r.calls}回 $${r.usd.toFixed(5)}${r.skipped ? `・skipped ${r.skipped}` : ""}`);
  for (const e of r.examples) console.log(`\n- ${e.id.slice(0, 8)} ${e.answer}`);
})().catch((e) => { console.error(e); process.exit(1); });
