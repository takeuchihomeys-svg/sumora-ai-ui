/**
 * 画像読みは flash（まとめの Pro と混ぜない・2026-11-16）
 * 実行: npx tsx app/lib/__tests__/shot-learn-model.test.ts
 */
import { SHOT_LEARN_DEFAULT_MODEL, shotLearnModel } from "../shot-learn-limit";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, detail ?? "");
  }
}

console.log("■ shotLearnModel（Vision=flash）");
ok("既定は deepseek-flash", shotLearnModel({}) === "deepseek-flash");
ok("SHOT_LEARN_DEFAULT_MODEL と同じ", shotLearnModel({}) === SHOT_LEARN_DEFAULT_MODEL);
ok("SHOT_LEARN_MODEL で上書き", shotLearnModel({ SHOT_LEARN_MODEL: "other" }) === "other");
ok("DEEPSEEK_MODEL=Pro でも Vision は flash", shotLearnModel({ DEEPSEEK_MODEL: "deepseek-v4-pro" }) === "deepseek-flash");

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
