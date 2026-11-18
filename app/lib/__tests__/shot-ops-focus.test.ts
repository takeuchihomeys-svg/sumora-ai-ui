/**
 * 仕組み㉑: ボタン1つずつの focus 照合
 * 実行: npx tsx app/lib/__tests__/shot-ops-focus.test.ts
 */
import { shotOpsMatchFocus } from "../shot-learn-server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
};

console.log("■ shotOpsMatchFocus");
ok("focus無しは常に true", shotOpsMatchFocus([{ f: "x" }], null) === true);
ok("所在地ボタンが当たる", shotOpsMatchFocus(
  [{ f: "左の所在地絞り込み＋｜span" }],
  ["所在地絞り込み＋"],
));
ok("別ボタンは当たらない", !shotOpsMatchFocus(
  [{ f: "左の沿線・駅絞り込み＋｜span" }],
  ["所在地絞り込み＋"],
));
ok("ops空は focus ありだと false", !shotOpsMatchFocus([], ["確定してリストへ"]));
ok("確定してリストへ", shotOpsMatchFocus(
  [{ f: "確定してリストへ｜span" }],
  ["確定してリストへ"],
));

console.log("\n■ 実装が focus を通す");
{
  const src = readFileSync(join(__dirname, "../shot-learn-server.ts"), "utf8");
  ok("findShotsToLearn が focusFields を受ける", /focusFields\?:/.test(src));
  ok("learnFromWeakShots が focusFields を渡す", /focusFields: opt\.focusFields/.test(src));
  const scr = readFileSync(join(__dirname, "../../../scripts/weak-strengthen.ts"), "utf8");
  ok("weak-strengthen が focusFields を渡す", /focusFields:/.test(scr));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
