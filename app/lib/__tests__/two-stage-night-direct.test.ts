// 夜の管理会社の話題で A1 の AIX 直接を外す（2026-11-06 作業員9・弱い所 345／350・MGMT_NIGHT_NO_DIRECT）
// 実行: npx tsx app/lib/__tests__/two-stage-night-direct.test.ts
import { answerableDirectAix, nightMgmtCheckDirection, type TwoStageVerdict } from "../two-stage";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const v: TwoStageVerdict = { kind: "check", direction: "", keyTopic: "", source: "rule:two_stage_promise(check)" };
const q136 = "ありがとうございます！\nちなみにこちらの物件礼金を調整することは難しいでしょうか？😣\nこちら駐車場は敷地内まだ空きありますでしょうか？💦";
const base = { decisionSource: "llm", firstContact: false, asksCost: false };
t("off: 夜でも今まで通り AIX 直接", answerableDirectAix(v, { ...base, customerText: q136, hourJst: 20 }, { MGMT_NIGHT_NO_DIRECT: "off" }) === "property_check_result");
t("既定 on（11/06）: 夜の q136 は AIX 直接にしない", answerableDirectAix(v, { ...base, customerText: q136, hourJst: 20 }, {}) === null);
const on = { MGMT_NIGHT_NO_DIRECT: "on" };
t("on: 20時の礼金と駐車場（q136 の実物）→ AIX 直接にしない", answerableDirectAix(v, { ...base, customerText: q136, hourJst: 20 }, on) === null);
t("on: 昼（14時）は今まで通り AIX 直接", answerableDirectAix(v, { ...base, customerText: q136, hourJst: 14 }, on) === "property_check_result");
t("on: 夜でも募集状況だけの問いは今まで通り", answerableDirectAix(v, { ...base, customerText: "上記2件の空き状況を教えてください", hourJst: 20 }, on) === "property_check_result");
t("on: 夜の保証・審査の問いは外さない（網に入れていない）", answerableDirectAix(v, { ...base, customerText: "保証会社の審査は通りますか", hourJst: 20 }, on) === "property_check_result");
// 夜の direction の結び（MGMT_NIGHT_DIRECTION・11/06 既定 on）
const cv: TwoStageVerdict = { kind: "check", direction: "お客様に聞かれた事を確認すると約束する返信にする。結びは実際の送信の形「確認出来次第ご連絡させて頂きます！！」", keyTopic: "", source: "rule:two_stage_promise(check)" };
t("夜の結び: =off は変えない", nightMgmtCheckDirection(cv, { customerText: q136, hourJst: 20 }, { MGMT_NIGHT_DIRECTION: "off" })?.direction === cv.direction);
const nd = nightMgmtCheckDirection(cv, { customerText: q136, hourJst: 20 }, { MGMT_NIGHT_DIRECTION: "on" });
t("夜の結び: on・20時の q136 → 竹内さんの 10/26 の形・出所は変えない", !!nd && nd.direction.includes("「本日管理会社営業時間外の為明日確認させて頂き、確認出来次第ご連絡させて頂きます！！」") && nd.source === cv.source, nd?.direction);
t("夜の結び: on でも昼は変えない", nightMgmtCheckDirection(cv, { customerText: q136, hourJst: 14 }, { MGMT_NIGHT_DIRECTION: "on" })?.direction === cv.direction);
t("夜の結び: on でも募集状況だけは変えない", nightMgmtCheckDirection(cv, { customerText: "上記2件の空き状況を教えてください", hourJst: 20 }, { MGMT_NIGHT_DIRECTION: "on" })?.direction === cv.direction);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
