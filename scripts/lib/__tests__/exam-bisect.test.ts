// 悪化した組を半分ずつに分ける（scripts/lib/exam-bisect.ts の bisectPlan）
// 実行: npx tsx scripts/lib/__tests__/exam-bisect.test.ts（全 PASS で exit 0）
import { bisectPlan, switchKeys } from "../exam-bisect";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

// 今夜の①の形（10スイッチ＋試験の道具の設定）
const env = { OWN_PROPERTY_PORTAL_TITLE: "on", OWN_PROPERTY_RETURNED_ESTIMATE: "on", ESTIMATE_TABLE_PARSE: "on", CONDUCTOR_OVERDUE_PROMISES: "on", EXHAUSTED_AREA_ALL_STRONG: "on",
  EXHAUSTED_PICKUP_READY: "on", BRAIN_FOCUS_DOC_DIGEST: "on", FOCUS_DOC_SENT_IMAGE: "on", INFO_FILL_MAP: "on", BRAIN_ESTIMATE_RECORDS: "on", EXAM_BASELINE_NIGHTLY: "off", LLM_CASSETTE_RPC: "off" };
ok("スイッチだけ数える（EXAM_・LLM_ は除く）", switchKeys(env).length === 10 && !switchKeys(env).some((k) => /^(EXAM_|LLM_)/.test(k)));

const r = bisectPlan({ label: "grp-brain-1121-p3", env, only: "q122,q167,q191,q205,q336,q124" }, ["q205", "q336", "q205"]);
ok("2本に分ける", "children" in r && r.children.length === 2, r);
if ("children" in r) {
  const [a, b] = r.children;
  ok("半分ずつ（5・5）・重ならない・全部入る", a.switches.length === 5 && b.switches.length === 5 && !a.switches.some((k) => b.switches.includes(k)) && [...a.switches, ...b.switches].length === 10);
  ok("試験の道具の設定は両方に写す", a.env.EXAM_BASELINE_NIGHTLY === "off" && b.env.LLM_CASSETTE_RPC === "off");
  ok("片方の env に他方のスイッチは無い", !b.switches.some((k) => k in a.env) && !a.switches.some((k) => k in b.env));
  ok("悪化した問題だけ・重複なし", a.only === "q205,q336" && b.only === "q205,q336", a.only);
  ok("label は -bA・-bB", a.label === "grp-brain-1121-p3-bA" && b.label === "grp-brain-1121-p3-bB");
  // もう一度分ける: -bA を分けると -bAA・-bAB
  const r2 = bisectPlan({ label: a.label, env: a.env, only: a.only }, ["q205"]);
  ok("続けて分けると -bAA・-bAB", "children" in r2 && r2.children[0].label === "grp-brain-1121-p3-bAA" && r2.children[1].label === "grp-brain-1121-p3-bAB", r2);
}
ok("スイッチが1つなら分けない（それが原因の候補）", "error" in bisectPlan({ label: "x", env: { A: "on", EXAM_X: "1" }, only: "q1" }, ["q1"]));
ok("悪化が0なら分けない", "error" in bisectPlan({ label: "x", env: { A: "on", B: "on" }, only: "q1" }, []));
ok("奇数は前を1つ多く（3→2・1）", (() => { const x = bisectPlan({ label: "x", env: { A: "on", B: "on", C: "on" }, only: "q1" }, ["q1"]); return "children" in x && x.children[0].switches.length === 2 && x.children[1].switches.length === 1; })());

console.log(`exam-bisect: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
