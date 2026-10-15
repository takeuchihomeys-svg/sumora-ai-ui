// scripts/audit-aix-template-block2.ts — 読むだけ。AIX の2通目（aix_template）の後ろのブロック（DB 由来）を
//   「全員で同じ（絶対原則・失注）」「状態で変わる（generate_reply＋全体のルール）」「ボタン×状態で変わる（アクション別ルール）」に分けた時の大きさ。
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-template-block2.ts
import { getCachedTopPrinciples, getCachedLossPatterns, getCachedPromptRules } from "../app/lib/prompt-cache";
import { aixTemplateDbKnowledgeParts, buildAixTemplateDbKnowledgeBlock } from "../app/lib/aix-template-cache";
import { aixTemplateStaticSystemText } from "../app/lib/aix-template-system";

const STATES = ["hearing", "proposing", "viewing", "applying", "screening", "contract"];
const ACTIONS = ["property_send", "property_recommendation", "property_check_result", "viewing_schedule", "estimate_send", "application_push"];

async function main() {
  const [tp, lp] = await Promise.all([getCachedTopPrinciples(), getCachedLossPatterns()]);
  console.log("static block0 chars", aixTemplateStaticSystemText().length);
  let shown = false;
  for (const st of STATES) {
    const gen = await getCachedPromptRules("generate_reply", { conversation_state: st });
    for (const a of ACTIONS) {
      const act = await getCachedPromptRules(a, { conversation_state: st }, false, true);
      const parts = aixTemplateDbKnowledgeParts(tp, lp, gen, act);
      const whole = buildAixTemplateDbKnowledgeBlock(tp, lp, [gen, act].filter(Boolean).join("\n"));
      const same = parts.map((p) => p.text).join("") === whole;
      if (!shown) { console.log("global(principles+loss) chars", parts[0]?.text.length); shown = true; }
      console.log(st.padEnd(10), a.padEnd(24), "parts", parts.map((p) => `${p.kind}:${p.text.length}`).join(" "), "whole", whole.length, same ? "SAME" : "DIFF!");
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
