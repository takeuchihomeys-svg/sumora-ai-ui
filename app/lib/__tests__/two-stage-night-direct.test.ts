// 夜の管理会社の話題で A1 の AIX 直接を外す（2026-11-06 作業員9・弱い所 345／350・MGMT_NIGHT_NO_DIRECT）
// 実行: npx tsx app/lib/__tests__/two-stage-night-direct.test.ts
import { answerableDirectAix, type TwoStageVerdict } from "../two-stage";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const v: TwoStageVerdict = { kind: "check", direction: "", keyTopic: "", source: "rule:two_stage_promise(check)" };
const q136 = "ありがとうございます！\nちなみにこちらの物件礼金を調整することは難しいでしょうか？😣\nこちら駐車場は敷地内まだ空きありますでしょうか？💦";
const base = { decisionSource: "llm", firstContact: false, asksCost: false };
t("off（既定）: 夜でも今まで通り AIX 直接", answerableDirectAix(v, { ...base, customerText: q136, hourJst: 20 }, {}) === "property_check_result");
const on = { MGMT_NIGHT_NO_DIRECT: "on" };
t("on: 20時の礼金と駐車場（q136 の実物）→ AIX 直接にしない", answerableDirectAix(v, { ...base, customerText: q136, hourJst: 20 }, on) === null);
t("on: 昼（14時）は今まで通り AIX 直接", answerableDirectAix(v, { ...base, customerText: q136, hourJst: 14 }, on) === "property_check_result");
t("on: 夜でも募集状況だけの問いは今まで通り", answerableDirectAix(v, { ...base, customerText: "上記2件の空き状況を教えてください", hourJst: 20 }, on) === "property_check_result");
t("on: 夜の保証・審査の問いは外さない（網に入れていない）", answerableDirectAix(v, { ...base, customerText: "保証会社の審査は通りますか", hourJst: 20 }, on) === "property_check_result");
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
