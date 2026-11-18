/**
 * 1録画→学習→改善→反映 の関所テスト
 * 実行: npx tsx app/lib/__tests__/one-rec-learn-loop.test.ts
 */
import { buildOneRecLearnLoop, enrichAtomsFromOneRec } from "../one-rec-learn-loop";
import { diagnoseAutoRecording } from "../auto-rec-diagnose";

function ok(name: string, cond: boolean) {
  if (!cond) throw new Error("FAIL: " + name);
  console.log("  ok", name);
}

console.log("one-rec-learn-loop");

{
  const honoka = buildOneRecLearnLoop({
    steps: [
      { k: "layout_grasp_partial", m: "把握 hit=1/2 不足=6" },
      { k: "search_cursor", m: "検索へ" },
      { k: "fill_done_gap", m: "started" },
    ],
    auditStatus: "started",
    layoutWantN: 2,
    layoutHitN: 1,
    searchArmed: false,
    fillDoneReached: false,
    propertyAcquireStarted: false,
    extVersion: "2.8.91",
    readCount: 0,
    autoAfterBundle: false,
    reflectOk: 0,
    pointPct: 40,
    aimAri: 0,
    aimNashi: 3,
  });
  ok("HONOKAはループ継続", honoka.continue_loop === true);
  ok("間取り部分原子あり", honoka.atoms.some((a) => a.id === "layout_partial_ok" || a.id === "layout_partial"));
  ok("fill-done切れ原子あり", honoka.atoms.some((a) => a.id === "fill_done_lost" || a.id === "property_no_pending"));
  ok("bottleneckがある", honoka.bottleneck_n != null);
  ok("検証印が5つ", honoka.verify_marks.length >= 5);
}

{
  const fixed = buildOneRecLearnLoop({
    steps: [
      { k: "layout_pre_search_ok", m: "間取り全hit 2/2" },
      { k: "search_armed", m: "物件取得のリロード生存印" },
      { k: "search_press_ok", m: "検索を押した" },
    ],
    auditStatus: "finished",
    layoutWantN: 2,
    layoutHitN: 2,
    searchArmed: true,
    fillDoneReached: true,
    propertyAcquireStarted: true,
    extVersion: "2.8.92",
    readCount: 2,
    autoAfterBundle: true,
    reflectOk: 1,
    pointPct: 70,
    aimAri: 4,
    aimNashi: 1,
  });
  ok("直った回は verify 段 ok", fixed.steps.find((s) => s.id === "verify")?.ok === true);
  ok("検証印に search_armed", fixed.verify_marks.some((x) => /search_armed/.test(x)));
}

{
  const base = diagnoseAutoRecording({
    steps: [{ k: "layout_pre_search_miss", m: "不足=6" }],
  });
  const atoms = enrichAtomsFromOneRec(
    { steps: [{ k: "layout_pre_search_miss", m: "不足=6" }], layoutWantN: 2, layoutHitN: 1 },
    base.atoms,
  );
  ok("diagnose+enrichで layout 原子", atoms.some((a) => /layout/.test(a.id)));
}

console.log("all ok");
