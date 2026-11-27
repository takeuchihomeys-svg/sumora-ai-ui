// npx tsx scripts/lib/__tests__/stage-coverage.test.ts
// 2026-11-27 作業員L（竹内さんの決め 11/27「on の部品は段階で読む」・作業員A と分けた）: 新しい部品のスイッチは段階（stagedOn／stageOnNow／stageOn）で読む。
//   今ある物（stage-coverage-allowlist.json）は警告だけ・一覧に無い新しいスイッチを env だけで読んだらこのテストで止める
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envSwitchesInCode, stagedSwitchesInCode, stageCoverage, scanDir, stagedOnNamesInCode, stagedNameCheck, scanStagedOnNames } from "../stage-coverage";

assert.deepEqual(envSwitchesInCode('(env.A_ON ?? "").trim().toLowerCase() === "on"; (env.B_ON ?? "").trim().toLowerCase() !== "off"; process.env.C_X === "on"'), ["A_ON", "B_ON", "C_X"], "既定 on も既定 off も拾う");
assert.deepEqual(stagedSwitchesInCode('stagedOn("A_ON", env); await stageOnNow("B_ON", conv, x); stageOn("C_X", c, env); stageOn(name, c, env)'), ["A_ON", "B_ON", "C_X"], "名前を直書きした呼び出しだけ（変数は数えない）");
assert.deepEqual(stageCoverage(["A_ON", "B_ON", "C_X", "EXAM_T"], new Set(["A_ON"]), new Set(["B_ON"])), { staged: ["A_ON"], allowed: ["B_ON"], fresh: ["C_X"] }, "試験の道具の切り替え（EXAM_）は数えない");
const allow = new Set(((JSON.parse(readFileSync(join(__dirname, "..", "stage-coverage-allowlist.json"), "utf8")) as { switches?: string[] }).switches ?? []));
const r = scanDir(join(__dirname, "..", "..", "..", "app", "lib"));
const c = stageCoverage(r.env, new Set(r.staged), allow);
if (c.allowed.length) console.log(`  ⚠ 段階で読んでいないスイッチ（今ある物・警告だけ）${c.allowed.length}`);
assert.deepEqual(c.fresh, [], `新しいスイッチが env だけで読まれている: ${c.fresh.join(",")}（段階 stagedOn("X") で読む・竹内さんの決め 11/27）`);
// 2026-11-27 A の名簿（STAGED_SWITCHES）との突き合わせ・段階で読むようになった物は許しの一覧から外す
assert.deepEqual(stagedOnNamesInCode('stagedOn("A_ON", env, S); stageOn("B_ON", c, env); stagedOn(n, env)'), ["A_ON"], "名簿の突き合わせは stagedOn の直書きだけ");
assert.deepEqual(stagedNameCheck(["A_ON", "B_ON"], new Set(["A_ON", "C_ON"]), new Set(["C_ON", "D_ON"])), { listedOnly: ["B_ON"], unlisted: ["C_ON"], staleAllow: ["C_ON"] });
{
  const { STAGED_SWITCHES } = require("../../../app/lib/switch-stage") as typeof import("../../../app/lib/switch-stage");
  const k = stagedNameCheck(STAGED_SWITCHES.map((x) => x.name), new Set(scanStagedOnNames(join(__dirname, "..", "..", "..", "app", "lib"))), new Set(r.staged.filter((x) => allow.has(x))));
  assert.deepEqual(k.listedOnly, [], `名簿にあるのに stagedOn で読んでいない: ${k.listedOnly.join(",")}`);
  assert.deepEqual(k.unlisted, [], `stagedOn で読んでいるのに名簿（STAGED_SWITCHES）に無い: ${k.unlisted.join(",")}（rollout-watch が見張らない）`);
  assert.deepEqual(k.staleAllow, [], `段階で読むようになったのに許しの一覧に残っている: ${k.staleAllow.join(",")}（stage-coverage-allowlist.json から外す）`);
}
console.log("stage-coverage ok 9");
