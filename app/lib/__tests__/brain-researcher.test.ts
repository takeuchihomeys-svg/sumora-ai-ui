// app/lib/__tests__/brain-researcher.test.ts — 2026-10-16 調べる係（DeepSeek が何を調べるか決める）の決まり
//   実行: npx tsx app/lib/__tests__/brain-researcher.test.ts
import { researcherTrigger, parseResearcherOutput, researcherBlock, brainResearcherEnabled } from "../brain-researcher";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("既定 off（試験で近づいた時だけ on）", !brainResearcherEnabled({}) && brainResearcherEnabled({ BRAIN_RESEARCHER: "on" }));
t("「さっきの部屋」で走る", researcherTrigger({ customerText: "さっきの部屋って駐車場ありますか？", postApply: false, propertyResolved: false }).run);
t("「前に言ってた条件」は物件が決まっていても走る", researcherTrigger({ customerText: "前に言ってた条件で探してほしいです", postApply: false, propertyResolved: true }).run);
t("台帳が1件に決めた物件の話は走らない", !researcherTrigger({ customerText: "さっきの部屋いいですね", postApply: false, propertyResolved: true }).run);
t("申込以降は走らない", !researcherTrigger({ customerText: "さっきの部屋", postApply: true, propertyResolved: false }).run);
t("前を指さない発言は走らない", !researcherTrigger({ customerText: "駐車場ありますか？", postApply: false, propertyResolved: false }).run);
const p = parseResearcherOutput('```json\n{"lookups":[{"kind":"sent_properties","query":""},{"kind":"past_lines","query":"駐車場"},{"kind":"bogus"},{"kind":"estimates"},{"kind":"viewings"}]}\n```');
t("読める・知らない kind は落とす・最大3件", !!p && p.length === 3 && p[0].kind === "sent_properties" && p[1].query === "駐車場" && p[2].kind === "estimates");
t("読めない時は null", parseResearcherOutput("わかりません") === null);
const b = researcherBlock({ customerText: "さっきの部屋", results: [{ kind: "sent_properties", query: "", lines: ["- 10-15 19:54 A 902号室・家賃70,000円"] }, { kind: "past_lines", query: "駐車場", lines: [] }] });
t("記録の行そのまま（まとめ直さない）・空の結果は出さない", /A 902号室・家賃70,000円/.test(b) && !/過去の会話の行/.test(b));
t("全部空なら材料なし", researcherBlock({ customerText: "x", results: [{ kind: "viewings", query: "", lines: [] }] }) === "");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
