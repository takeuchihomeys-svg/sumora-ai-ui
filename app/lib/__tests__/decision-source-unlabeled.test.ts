// app/lib/__tests__/decision-source-unlabeled.test.ts — LLM の AIX を名前なしで落とした番の名札（DECISION_SOURCE_UNLABELED・既定 off）の配線
//   実行: npx tsx app/lib/__tests__/decision-source-unlabeled.test.ts
import { readFileSync } from "node:fs";
const core = readFileSync("app/lib/brain-core.ts", "utf8");
let fail = 0;
const t = (n: string, ok: boolean) => { if (!ok) { fail++; console.error(`NG ${n}`); } };
t("既定 off（=on の時だけ）", core.includes('(process.env.DECISION_SOURCE_UNLABELED ?? "").trim().toLowerCase() === "on"'));
t("名札は decision_source_no_aix にだけ（道は変えない）", core.includes('!finalAix && !decisionSource && decisionSourceUnlabeledOn() && parsed.reply_mode === "aix" && !!normalizeAixActionKey(parsed.aix)'));
t("約束の直後のお礼・2段・その他の3つの名前", core.includes('"rule:ack_after_promise"') && core.includes("`rule:unlabeled_two_stage(${twoStage.kind})`") && core.includes('"rule:unlabeled_aix_drop"'));
console.log(fail ? `${fail} NG` : "decision-source-unlabeled: 全部 ok");
process.exit(fail ? 1 : 0);
