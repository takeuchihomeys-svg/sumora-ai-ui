// 同じ日の2通目でも募集状況の確認は約束のまま（2026-11-10 作業員1・弱い所 two-stage-same-day-direct-repromise・TWO_STAGE_SAME_DAY_REPROMISE）
// 実物の形: q371（11/03 19:35・13分前の「新大阪グランドハイツと新大阪ステーションビルの募集状況確認させて頂きます」の後に3件目の SUUMO の URL）
// 実行: npx tsx app/lib/__tests__/two-stage-same-day-repromise.test.ts
// 時計: jstParts は TEST_CLOCK_JST_HOUR（テストの印があるときだけ効く）で昼の14時に固定する（LLM は呼ばない）
process.env.LLM_TEST_MODE = "deepseek-all";
process.env.TEST_CLOCK_JST_HOUR = "14";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTwoStage, sameDayRepromiseKeeps } from "../two-stage";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log(`  NG  ${name}`); } };
const base = { decisionSource: "llm", pickupReady: false, postApply: false };
const brought2nd = { ...base, finalAix: "property_check_result", brought: { ask: "none" as const, count: 1 }, customerText: "ART TENDOU WEST 1階\nhttps://suumo.jp/chintai/bc_100532288607/\nby SUUMO", promisedTodayKinds: ["check" as const] };

t("純関数: 既定 on（11/11）・=off で止まる", sameDayRepromiseKeeps("check", {}) === true && sameDayRepromiseKeeps("check", { TWO_STAGE_SAME_DAY_REPROMISE: "off" }) === false);
t("純関数: on は確認だけ", sameDayRepromiseKeeps("check", { TWO_STAGE_SAME_DAY_REPROMISE: "on" }) === true && sameDayRepromiseKeeps("estimate", { TWO_STAGE_SAME_DAY_REPROMISE: "on" }) === false);

process.env.TWO_STAGE_SAME_DAY_REPROMISE = "off";
t("=off: 昼の同じ日の2通目の持ち込み → 旧の形の AIX 直接（null）", resolveTwoStage(brought2nd) === null);
process.env.TWO_STAGE_SAME_DAY_REPROMISE = "on";
const v = resolveTwoStage(brought2nd);
t("on: 昼の同じ日の2通目の持ち込み（q371 の形）→ 確認の約束のまま", v?.kind === "check" && v?.source === "rule:two_stage_promise(brought_both)");
t("on: 見積の2通目は今まで通り AIX 直接", resolveTwoStage({ ...base, finalAix: "estimate_sheet", promisedTodayKinds: ["estimate"] }) === null);
t("on: 1通目（今日の約束なし）は約束のまま", resolveTwoStage({ ...brought2nd, promisedTodayKinds: [] })?.kind === "check");
delete process.env.TWO_STAGE_SAME_DAY_REPROMISE;

const src = readFileSync(join(__dirname, "..", "two-stage.ts"), "utf8");
t("配線: sameDayDirect の頭で sameDayRepromiseKeeps を見る", /if \(!SAME_DAY_SOURCES\.test\(v\.source\)\) return false;\s*\n\s*if \(sameDayRepromiseKeeps\(v\.kind, typeof process === "undefined" \? \{\} : process\.env\)\) return false;/.test(src));
console.log(`two-stage-same-day-repromise: ${pass}/${pass + fail}`); if (fail) process.exit(1);
