/**
 * build_v14: 手順書の骨組みの外しは「1つずつ外す」ではなくリセットボタン（2026-11-26 竹内さん）
 * npx tsx app/lib/__tests__/playbook-reset-skeleton.test.ts
 */
import { PLAYBOOK_BUILD_V, PLAYBOOK_FLOW_SERIES, PLAYBOOK_EXTRA_GUIDES } from "../action-playbook";
import { AUTO_RULES } from "../auto-procedure-rules";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(PLAYBOOK_BUILD_V >= 14, "build_v14");
const clear = PLAYBOOK_EXTRA_GUIDES.find((g) => g.id === "clear")!;
const text = clear.steps.join("\n");
assert(/リセット/.test(clear.steps[1]), "手2はリセットを押す");
assert(/30秒以上/.test(text), "ラグ待ち30秒以上");
// 2.8.317（build_v24）: 送付後のリセットは「押して30〜34秒待ったら空とみなす」。読み戻し（名前付き）はしない
assert(/空/.test(clear.steps[3]) && /reset_settled/.test(clear.steps[3]), "手4は空とみなす（reset_settled）");
assert(/API/.test(clear.steps[4]) && /customer_api_reload/.test(clear.steps[4]), "手5は次客の条件をAPIから読み直して入れる");
assert(!/猶予を置く/.test(text), "リセット後の猶予は置かない");
assert(!/1つずつカーソルで外す|1駅ずつ外す|箱ごとに開ける→/.test(text), "旧の1つずつ外す手が残っていない");
assert(/最後の保険/.test(clear.steps[clear.steps.length - 1]), "1つずつ外すは最後の保険だけ");
for (const id of ["reset_replaces_clear", "reset_between_customers", "reset_retry_insurance"]) {
  assert(clear.rules.includes(id), "clear の決まりに " + id);
}
assert(!clear.rules.includes("clear_one_by_one") && !clear.rules.includes("clear_per_panel"), "1つずつ外す決まりを clear から外した");
for (const id of clear.rules) assert(AUTO_RULES.some((r) => r.id === id), "決まりが実在する: " + id);
const sw = PLAYBOOK_EXTRA_GUIDES.find((g) => g.id === "switch")!;
assert(/リセット/.test(sw.steps[2]) && /30秒以上/.test(sw.steps[2]), "switch 手3もリセット");
for (const id of ["before_clear", "clear_then_fill", "after_clear"]) {
  const ph = PLAYBOOK_FLOW_SERIES.find((p) => p.id === id)!;
  assert(ph.grasp.some((g) => /^reset_/.test(g)), id + " にリセットの印");
}
assert(PLAYBOOK_FLOW_SERIES.find((p) => p.id === "before_clear")!.grasp.includes("reset_press"), "before_clear に reset_press");
console.log("playbook-reset-skeleton.test OK");