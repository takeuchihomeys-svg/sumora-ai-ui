// 2026-11-13 作業員7b: 審査の事情の番（S3・ブレインが返信）に持ち込みの約束を当てない（BROUGHT_SCREENING_NO_PROMISE・既定 off）
//   実物: 見張り 12348（「彼氏名義で審査落ちててここって厳しいですよね？？」＋物件の画面の画像・場面 S3_screening・合図の候補 property_check_result・ブレインの aix は空）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTwoStage, broughtScreeningNoPromiseOn } from "../two-stage";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${n}`); } else { fail++; console.log(`  NG  ${n}`); } };
const base = { decisionSource: null, pickupReady: false, postApply: false, finalAix: "property_check_result", customerText: "彼氏との同棲で家探してて、ここ住みたかったんですけど、彼氏名義で審査落ちててここって厳しいですよね？？", brought: { ask: "other" as const, count: 1 }, screeningBrainReply: true } as unknown as Parameters<typeof resolveTwoStage>[0];
delete process.env.BROUGHT_SCREENING_NO_PROMISE;
t("既定 off", !broughtScreeningNoPromiseOn({}) && broughtScreeningNoPromiseOn({ BROUGHT_SCREENING_NO_PROMISE: "on" }));
t("off は今まで通り持ち込みの約束（brought_both）", /brought/.test(resolveTwoStage(base)?.source ?? ""));
process.env.BROUGHT_SCREENING_NO_PROMISE = "on";
t("on: 12348 は約束にしない（ブレインの返信のまま）", resolveTwoStage(base) === null);
t("on でも審査の事情でない持ち込みは今まで通り", /brought/.test(resolveTwoStage({ ...base, screeningBrainReply: false, customerText: "ここ空いてますか？" })?.source ?? ""));
delete process.env.BROUGHT_SCREENING_NO_PROMISE;
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: brain-core が screeningBrainReply を2段に渡している", bc.includes("const screeningBrainReply = sceneEvidence?.scene === \"S3_screening\"") && bc.includes("screeningBrainReply,"));
console.log(`brought-screening-no-promise: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
