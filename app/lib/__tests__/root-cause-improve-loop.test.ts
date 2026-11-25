/**
 * F64 根本原因改善ループ（決定論）
 * 実行: npx tsx app/lib/__tests__/root-cause-improve-loop.test.ts
 */
import {
  classifyFixAsSurface,
  caseVerified,
  evaluateRootCauseImproveLoop,
  ROOT_CAUSE_CANON_CASES,
  type RootCauseCase,
} from "../root-cause-improve-loop";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name + (detail ? "  " + detail.slice(0, 160) : ""));
  }
}

console.log("\n■ 表面直し判定");
ok("surface_only は表面", classifyFixAsSurface("surface_only", "関所追加") === true);
ok("文言だけは表面", classifyFixAsSurface("premature_advance", "文言だけ直す") === true);
ok("関所追加は表面ではない", classifyFixAsSurface("premature_advance", "_guardNextMove 関所") === false);

console.log("\n■ 症例検証");
const base = { ...ROOT_CAUSE_CANON_CASES[0], dbEvidence: "audit#1608 conditions_done 次=並べ替え" };
{
  const r = caseVerified(base, ["page:next_move_premature_block"], "2.8.233");
  ok("実証印あり→ok", r.ok === true, r.gaps.join("/"));
}
{
  const r = caseVerified(base, ["page:task_next"], "2.8.233");
  ok("実証印なし→ng", r.ok === false);
  ok("gaps に実証印", r.gaps.some((g) => /実証印/.test(g)));
}
{
  const r = caseVerified(base, ["page:next_move_premature_block"], "2.8.232");
  ok("古い版の印だけではng", r.ok === false);
  ok("gaps に実証版", r.gaps.some((g) => /実証版/.test(g)));
}
{
  const thin: RootCauseCase = {
    ...base,
    dbEvidence: "未測",
    rootKind: "surface_only",
    testPath: "",
    minVerifyExtVersion: undefined,
  };
  const r = caseVerified(thin, []);
  ok("DB無し・表面・テスト無し→複数gaps", r.gaps.length >= 3);
}

console.log("\n■ ループ完了線");
{
  const bad = evaluateRootCauseImproveLoop({
    cases: [{ ...base, dbEvidence: "未測" }],
    extTestOk: false,
    latestAuditKeys: [],
    latestExtVersion: "2.8.230",
    codeExtVersion: "2.8.233",
  });
  ok("未完了は ok=false", bad.ok === false);
  ok("F58未PASS が gaps", bad.gaps.some((g) => /F58/.test(g)));
}
{
  const good = evaluateRootCauseImproveLoop({
    cases: [base],
    extTestOk: true,
    latestAuditKeys: ["page:next_move_premature_block", "page:search_press_ok"],
    latestExtVersion: "2.8.234",
    codeExtVersion: "2.8.234",
  });
  ok("全部揃えば ok", good.ok === true, good.line);
  ok("line に根本改善✓", /根本改善✓/.test(good.line));
}
{
  const onePage = {
    ...ROOT_CAUSE_CANON_CASES[1],
    dbEvidence: "audit直近 onePage=0／画面1ページで次ページ止まり",
  };
  const r = caseVerified(onePage, ["dl:list_page_one_only"], "2.8.234");
  ok("1ページ症例・実証印あり", r.ok === true, r.gaps.join("/"));
  const r2 = caseVerified(onePage, ["page:search_press_ok"], "2.8.234");
  ok("1ページ症例・無関係印はng", r2.ok === false);
}
{
  const cont = {
    ...ROOT_CAUSE_CANON_CASES.find((c) => c.id === "continuous_loop_advance_thin")!,
    dbEvidence: "直近50 series_done=4 loop_advance=1",
  };
  const oldOk = caseVerified(cont, ["loop_advance", "loop_who_grasp"], "2.8.225");
  ok("連続客・古い版のloop_advanceだけではng", oldOk.ok === false);
  const newOk = caseVerified(cont, ["loop_advance", "loop_who_grasp"], "2.8.235");
  ok("連続客・2.8.235以降＋印→ok", newOk.ok === true, newOk.gaps.join("/"));
}
{
  const to = {
    ...ROOT_CAUSE_CANON_CASES.find((c) => c.id === "timeout_without_screen_poll")!,
    dbEvidence: "直近40 timeoutOnly=3",
  };
  const oldTo = caseVerified(to, ["screen_poll_grasp"], "2.8.232");
  ok("画面照会・古い版だけではng", oldTo.ok === false);
  const newTo = caseVerified(to, ["page:screen_poll_api_next"], "2.8.236");
  ok("画面照会・2.8.236＋印→ok", newTo.ok === true, newTo.gaps.join("/"));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
