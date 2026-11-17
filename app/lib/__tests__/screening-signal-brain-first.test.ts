// 審査の通りやすさの問いで S3 の信号がブレインの「なし」を埋めない（2026-11-18 作業員H・SCREENING_SIGNAL_BRAIN_FIRST・既定 off）
// 実行: npx tsx app/lib/__tests__/screening-signal-brain-first.test.ts
import { screeningSignalBrainFirstOn, screeningSignalSkipped } from "../screening-signal-brain-first";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const on = { SCREENING_SIGNAL_BRAIN_FIRST: "on" };
t("既定 off", !screeningSignalBrainFirstOn({}) && screeningSignalBrainFirstOn(on));
t("off は今まで通り（埋める）", !screeningSignalSkipped({ reasonCode: "screening_question", brainSaidNoAix: true }, {}));
t("on・通りやすさの問い・ブレインがなし → 埋めない", screeningSignalSkipped({ reasonCode: "screening_question", brainSaidNoAix: true }, on));
t("on・ブレインが分からない語（なしと言っていない）→ 今まで通り", !screeningSignalSkipped({ reasonCode: "screening_question", brainSaidNoAix: false }, on));
t("on・保証会社そのものの問い（AIX【保証会社】）は今まで通り", !screeningSignalSkipped({ reasonCode: "guarantor_question", brainSaidNoAix: true }, on));
t("on・管理会社の問いは今まで通り", !screeningSignalSkipped({ reasonCode: "mgmt_company_question", brainSaidNoAix: true }, on));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
