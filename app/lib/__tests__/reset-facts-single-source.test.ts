/**
 * リセットの数字（幅・待ち秒数）が、骨組みと決まりで1つにそろうか（C・2026-11-26）
 * npx tsx app/lib/__tests__/reset-facts-single-source.test.ts
 */
import { AUTO_RULES } from "../auto-procedure-rules";
import { PLAYBOOK_EXTRA_GUIDES, PLAYBOOK_FLOW_SERIES } from "../action-playbook";
import { RESET_BUTTON_SIZE, RESET_WAIT_MIN_SEC, RESET_WAIT_RANGE, RESET_WAIT_TEXT } from "../reset-facts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 1. 骨組みの手に、正本の数字が入っている
const clear = PLAYBOOK_EXTRA_GUIDES.find((g) => g.id === "clear")!;
assert(clear.steps.some((s) => s.includes(RESET_BUTTON_SIZE)), "clear の手にリセットの幅（正本）");
assert(clear.steps.some((s) => s.includes(RESET_WAIT_TEXT)), "clear の手にラグ待ち（正本）");
const sw = PLAYBOOK_EXTRA_GUIDES.find((g) => g.id === "switch")!;
assert(sw.steps.some((s) => s.includes(RESET_WAIT_TEXT)), "switch の手にラグ待ち（正本）");
const before = PLAYBOOK_FLOW_SERIES.find((p) => p.id === "before_clear")!;
assert(before.label.includes(RESET_WAIT_TEXT), "一連の before_clear の名前にラグ待ち（正本）");
console.log("  ✓ 骨組みの手・名前が正本の数字を使う");

// 2. 決まり（リセットの幅と待ちを定めている物）が正本と同じ
const between = AUTO_RULES.find((r) => r.id === "reset_between_customers")!;
assert(between.text.includes(RESET_BUTTON_SIZE), "reset_between_customers に幅（正本）");
assert(between.text.includes(RESET_WAIT_RANGE), "reset_between_customers に待ちの範囲（正本）");
console.log("  ✓ 決まり reset_between_customers が正本の幅・待ちと一致");

// 3. リセットの後の待ちを、どの決まりも別の数字で書いていない（「リセット…N秒以上」の N は正本の値だけ）
//    2.8.292 以前の『8〜13秒』（リセット後の見る間）等は「秒以上」を使わないので対象外
const bad: string[] = [];
const re = /リセット[^。、（）]{0,30}?(\d+)秒以上/g;
for (const r of AUTO_RULES) {
  for (const m of r.text.matchAll(re)) {
    if (Number(m[1]) !== RESET_WAIT_MIN_SEC) bad.push(r.id + ": " + m[0]);
  }
}
for (const g of PLAYBOOK_EXTRA_GUIDES) {
  for (const s of g.steps) for (const m of s.matchAll(re)) if (Number(m[1]) !== RESET_WAIT_MIN_SEC) bad.push(g.id + ": " + m[0]);
}
assert(bad.length === 0, "リセットの待ちが正本と違う数字で書かれている:\n" + bad.join("\n"));
console.log("  ✓ リセットの『N秒以上』は、どこも正本 " + RESET_WAIT_MIN_SEC + " 秒");

console.log("reset-facts-single-source.test OK");
