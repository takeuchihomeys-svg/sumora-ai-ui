/**
 * F58 拡張テスト改善ループの完了線
 * npx tsx app/lib/__tests__/ext-test-improve-loop.test.ts
 */
import {
  EXT_TEST_IMPROVE_SUITE,
  evaluateExtTestLoop,
  auditExtTestImproveLoop,
  scanExtWiringFindings,
} from "../ext-test-improve-loop";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(EXT_TEST_IMPROVE_SUITE.length >= 10, "suite size");
assert(
  EXT_TEST_IMPROVE_SUITE.some((t) => t.id === "search_customer_grasp_gaps"),
  "grasp gaps in suite",
);
assert(
  EXT_TEST_IMPROVE_SUITE.some((t) => t.id === "auto_procedure_rules"),
  "rules test in suite",
);
assert(
  EXT_TEST_IMPROVE_SUITE.some((t) => t.id === "playbook_search_extra_guides"),
  "build_v9 search/extra guides in suite",
);
assert(
  EXT_TEST_IMPROVE_SUITE.some((t) => t.id === "playbook_ad_sort_clear"),
  "AD sort in suite",
);
assert(
  EXT_TEST_IMPROVE_SUITE.some((t) => t.id === "action_playbook"),
  "action-playbook in suite",
);
assert(
  EXT_TEST_IMPROVE_SUITE.some((t) => t.id === "human_like_audit"),
  "human_like_audit in suite",
);
assert(
  EXT_TEST_IMPROVE_SUITE.some((t) => t.id === "human_nearness"),
  "human_nearness in suite",
);
assert(
  EXT_TEST_IMPROVE_SUITE.some((t) => t.id === "human_like_wiring"),
  "human_like_wiring in suite",
);
assert(
  EXT_TEST_IMPROVE_SUITE.some((t) => t.id === "human_like_improve_loop"),
  "human_like_improve_loop in suite",
);
assert(EXT_TEST_IMPROVE_SUITE.length >= 16, "suite includes human-like improve");

{
  const stamp = evaluateExtTestLoop({
    runs: [
      { id: "a", path: "a", ok: true, ms: 1, detail: "ok" },
      { id: "b", path: "b", ok: false, ms: 2, detail: "fail" },
    ],
    findings: [],
    manifest_ver: "2.8.196",
    rules_reviewed: "2.8.196",
  });
  assert(!stamp.ok, "fail run → not ok");
  assert(stamp.fail_n === 1, "fail_n");
  assert(/落ちたテスト/.test(stamp.next), "next names fail");
}

{
  const stamp = evaluateExtTestLoop({
    runs: [{ id: "a", path: "a", ok: true, ms: 1, detail: "ok" }],
    findings: [
      {
        id: "rules_reviewed_stale",
        layer: "free",
        gap: "stale",
        next: "bump",
        fixable: true,
      },
    ],
    fixed: [],
    manifest_ver: "2.8.196",
    rules_reviewed: "2.8.185",
  });
  assert(!stamp.ok, "finding → not ok");
  assert(/--fix/.test(stamp.next), "fixable next");
}

{
  const stamp = evaluateExtTestLoop({
    runs: [{ id: "a", path: "a", ok: true, ms: 1, detail: "ok" }],
    findings: [
      {
        id: "rules_reviewed_stale",
        layer: "free",
        gap: "stale",
        next: "bump",
        fixable: true,
      },
    ],
    fixed: ["rules_reviewed_stale"],
    manifest_ver: "2.8.196",
    rules_reviewed: "2.8.196",
  });
  assert(stamp.ok, "fixed finding → ok");
}

{
  // 配線スキャンは実ファイルを見る（件数は状況依存・落ちないこと）
  const f = scanExtWiringFindings(process.cwd());
  assert(Array.isArray(f), "scan returns array");
  console.log("✓ scan findings", f.length);
}

{
  const a = auditExtTestImproveLoop(process.cwd());
  assert(typeof a.ok === "boolean", "audit ok bool");
  assert(typeof a.line === "string" && a.line.length > 5, "audit line");
  assert(typeof a.next === "string" && a.next.length > 5, "audit next");
  console.log("✓ audit", a.ok ? "完了" : "未完", a.line.slice(0, 80));
}

console.log("\next-test-improve-loop.test OK");
