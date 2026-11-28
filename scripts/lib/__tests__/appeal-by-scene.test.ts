// scripts/lib/__tests__/appeal-by-scene.test.ts — #755 訴求を場面で分けて数える（作り物の照らしの行）
import assert from "node:assert/strict";
import { appealByScene } from "../appeal-by-scene";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  OK  " + name); } catch (e) { fail++; console.log("  NG  " + name + "\n      " + (e as Error).message); } };
const R = (node: string, act: string, reached = false, writer = "takeuchi", branch: string | null = null) => ({ conv: "x", at: "2026-11-01T00:00:00Z", node, branch, act, reached, writer });

t("内覧・申込の誘いは訴求・見積の約束は別・竹内さん本人だけ", () => {
  const out = appealByScene([R("estimate", "reply:invite_viewing", true), R("estimate", "reply:invite_apply"), R("estimate", "reply:invite_estimate"), R("estimate", "reply:answer", true), R("estimate", "reply:invite_viewing", false, "employee")]);
  const e = out.find((x) => x.scene === "estimate")!;
  assert.deepEqual([e.n, e.appeal, e.viewing, e.apply, e.estimate, e.reachedAppeal, e.reachedOther], [4, 2, 1, 1, 1, 1, 1]);
});
t("分かれ道は 分: で別の場面・全員にもできる", () => {
  const out = appealByScene([R("hearing", "aix:application_push", false, "employee", "move_in_later")], { writers: "all" });
  assert.equal(out[0].scene, "分:move_in_later"); assert.equal(out[0].apply, 1);
});
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
