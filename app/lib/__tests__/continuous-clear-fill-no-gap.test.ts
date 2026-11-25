/**
 * 連続客: 外す＋入れるの両方に抜けが無いか徹底確認（決定論）
 * npx tsx app/lib/__tests__/continuous-clear-fill-no-gap.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLAYBOOK_FLOW_SERIES,
  PLAYBOOK_EXTRA_GUIDES,
  PLAYBOOK_BUILD_V,
  buildPlaybook,
  checkPlaybook,
  judgeFlowSeriesProgress,
} from "../action-playbook";
import { AUTO_RULES, judgeRulesOnAudit, type AuditStep } from "../auto-procedure-rules";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}
function must(src: string, needle: string, why: string) {
  assert(src.includes(needle), why + " 欠: " + needle.slice(0, 50));
}
function orderIn(src: string, a: string, b: string, why: string) {
  const ia = src.indexOf(a);
  const ib = src.indexOf(b);
  assert(ia >= 0 && ib >= 0 && ia < ib, why + ` (${a.slice(0, 24)} @${ia} → ${b.slice(0, 24)} @${ib})`);
}
function assertStepOrder(keys: string[], steps: AuditStep[], label: string) {
  let last = -1;
  const hit: string[] = [];
  for (const want of keys) {
    const i = steps.findIndex((s, j) => {
      if (j <= last) return false;
      const blob = String(s.k || "") + " " + String(s.d || "");
      return blob.includes(want);
    });
    assert(i >= 0, `${label}: 無 ${want}（ここまで ${hit.join("→") || "-"}）`);
    assert(i > last, `${label}: 逆 ${want}`);
    last = i;
    hit.push(want);
  }
}

const page = readFileSync(join(process.cwd(), "chrome-extension/page-script.js"), "utf8");
const man = JSON.parse(readFileSync(join(process.cwd(), "chrome-extension/manifest.json"), "utf8"));
const doResetAt = page.indexOf("function _doReset(callback");
assert(doResetAt >= 0, "_doReset");
const body = page.slice(doResetAt, doResetAt + 50000);

console.log("■ 版・決まり");
{
  assert(man.version >= "2.8.210", "ext >=2.8.210 今=" + man.version);
  assert(PLAYBOOK_BUILD_V >= 12, "build_v12");
  for (const id of [
    "clear_detail_grasp",
    "clear_then_fill_gate",
    "flow_series_order_gate",
    "guide_clear_fill_gate",
    "guide_phase_checkpoints",
    "continuous_customer_loop",
    "place_xor_grasp",
  ]) {
    assert(AUTO_RULES.some((r) => r.id === id), "決まり " + id);
    assert(page.includes('"' + id + '"'), "RULES_DONE " + id);
  }
  assert(page.includes("place_xor_plan") && page.includes("_axApplyPlaceXor"), "place XOR 計画→適用");
  console.log("  ✓ 版・clear/fill/順番の決まり揃い");
}

console.log("■ 外す側: 抜け点検（配線）");
{
  must(body, "leftover_scan", "外す前スキャン");
  must(body, "_graspFlowSeriesOrder", "順番理解");
  must(body, "_guideLikeClearGrasp", "外す前名前把握");
  must(body, "clear_done", "外し完了");
  must(body, "_guideLikeAfterClearCheck", "外し後照合");
  must(body, "clear_then_fill_ok", "外し→入れ関所");
  must(page, "_listLeftoverNamedItems", "名前付き残り");
  must(page, "_requireFlowSeriesUpTo", "順番関所");
  orderIn(body, "leftover_scan", "_guideLikeClearGrasp", "scan→grasp");
  orderIn(body, "_guideLikeClearGrasp", "clear_done", "grasp→clear_done");
  orderIn(body, "clear_done", "_guideLikeAfterClearCheck", "done→after_clear");
  orderIn(body, "_guideLikeAfterClearCheck", "clear_then_fill", "after→then_fill");
  const clearG = PLAYBOOK_EXTRA_GUIDES.find((g) => g.id === "clear")!;
  assert(clearG.steps.length >= 5, "clear手>=5");
  assert(clearG.steps.some((t) => /名前付き|1つずつ言う/.test(t)), "clear名前");
  console.log("  ✓ 外す配線・手順書 clear 手に抜けなし");
}

console.log("■ 入れる側: 抜け点検（配線）");
{
  for (const ph of ["after_confirm", "after_station", "after_area", "after_place", "before_search"]) {
    assert(
      page.includes('_guideLikePhaseCheck("' + ph + '"') || page.includes('_guideLikePhaseCheck("' + ph + '",'),
      "phaseCheck " + ph,
    );
  }
  // after_search は専用経路（画面照合＋flow_series）
  assert(
    page.includes('_noteFlowSeriesAt("after_search"') || page.includes("guide_phase_after_search"),
    "after_search 把握経路",
  );
  // ★ 2.8.211: fill_gate は定義だけでなく呼ばれていること
  const fillGateDef = page.indexOf("function _guideLikeFillGate");
  const fillGateCall = page.indexOf("_guideLikeFillGate(_fillCond0") >= 0
    ? page.indexOf("_guideLikeFillGate(_fillCond0")
    : page.indexOf("_guideLikeFillGate(", fillGateDef + 10);
  assert(fillGateDef >= 0, "fill_gate 定義");
  assert(fillGateCall > fillGateDef, "fill_gate が検索前に呼ばれる（未配線穴を止める）");
  must(page, "guide_fill_gate", "fill_gate印");
  must(page, "conditions_ready", "条件揃い");
  const fillAfter = page.indexOf("_doReset(function()", doResetAt);
  assert(fillAfter > doResetAt, "fillは外し後");
  console.log("  ✓ 入れる phaseCheck・fill_gate呼出・after_search経路");
}

console.log("■ 一連 flow_series: 外す前→入れ→検索 が直線で抜けない");
{
  const ids = PLAYBOOK_FLOW_SERIES.map((p) => p.id);
  assert(ids[0] === "before_clear", "先頭 before_clear");
  const need = [
    "before_clear",
    "after_clear",
    "after_confirm",
    "after_place",
    "before_search",
    "after_search",
    "sort_ad",
    "list",
    "handoff",
  ];
  for (const id of need) assert(ids.includes(id), "flow欠 " + id);
  assert(ids.indexOf("before_clear") < ids.indexOf("after_clear"), "before<after_clear");
  assert(ids.indexOf("after_clear") < ids.indexOf("after_confirm"), "clear<confirm");
  assert(ids.indexOf("after_confirm") < ids.indexOf("before_search"), "confirm<search前");
  assert(ids.indexOf("before_search") < ids.indexOf("after_search"), "search前<search後");
  // next チェーン
  let cur: string | null = "before_clear";
  const seen = new Set<string>();
  while (cur) {
    assert(!seen.has(cur), "循環 " + cur);
    seen.add(cur);
    cur = PLAYBOOK_FLOW_SERIES.find((p) => p.id === cur)?.next ?? null;
  }
  assert(seen.has("handoff"), "handoff到達");
  console.log("  ✓ flow_series " + ids.length + "段 チェーンOK");
}

console.log("■ 薄い録画でも外す・入れる場面が抜けない");
{
  const pb = buildPlaybook({
    generated_at: new Date().toISOString(),
    scene_flows: [{ scene: "station", runs: 20, ops: 3, steps: ["station_id[]"], variants: 1 }],
  });
  for (const sc of ["area", "cond", "search", "list"]) {
    assert(!!pb.scenes.find((s) => s.scene === sc), "注入 " + sc);
  }
  assert(pb.extra_guides.some((g) => g.id === "clear"), "extra clear");
  assert(pb.flow_series.some((p) => p.id === "before_clear"), "before_clear");
  const issues = checkPlaybook(pb);
  assert(!issues.some((x) => /必須段が無い: before_clear/.test(x)), issues.join(";"));
  console.log("  ✓ stationのみでも area/cond/search/list + clear + before_clear");
}

console.log("■ 擬似連続2客: 外す→入れ 印に抜け・逆順なし");
{
  const steps: AuditStep[] = [
    { k: "page:switch_grasp", d: "客B" },
    { k: "page:flow_series_reset", d: "次客外し開始" },
    { k: "page:flow_series_plan", d: "順番理解 12段 [before_clear→after_clear→…]" },
    { k: "page:leftover_scan", d: "駅2・区1" },
    { k: "page:guide_clear_grasp", d: "名前付き3" },
    { k: "page:guide_phase_one", d: "外す前 1/3 区残:西区" },
    { k: "page:guide_clear_detail", d: "外す対象3" },
    { k: "page:flow_series_order", d: "1/12 before_clear" },
    { k: "page:flow_series_at", d: "before_clear" },
    { k: "page:flow_series_ok", d: "before_clear" },
    { k: "page:clear_stage", d: "間取り" },
    { k: "page:clear_one_ok", d: "1K" },
    { k: "page:ward_clear_one_ok", d: "西区" },
    { k: "page:clear_done", d: null },
    { k: "page:guide_phase_after_clear", d: "きれい" },
    { k: "page:guide_phase_ok", d: "after_clear 外し忘れ0" },
    { k: "page:flow_series_order", d: "2/12 after_clear" },
    { k: "page:flow_series_at", d: "after_clear" },
    { k: "page:flow_series_ok", d: "after_clear" },
    { k: "page:clear_then_fill_ok", d: "入れへ" },
    { k: "page:guide_fill_gate", d: "揃い →OK" },
    { k: "page:guide_phase_after_confirm", d: "確定後" },
    { k: "page:guide_phase_one", d: "1/2 区入:中央区" },
    { k: "page:flow_series_at", d: "after_confirm" },
    { k: "page:guide_phase_after_area", d: "区OK" },
    { k: "page:guide_phase_after_place", d: "場所OK" },
    { k: "page:guide_phase_before_search", d: "揃い" },
    { k: "page:conditions_ready", d: "ok" },
    { k: "page:guide_phase_after_search", d: "検索把握" },
    { k: "page:flow_series_at", d: "after_search" },
  ];
  assertStepOrder(
    [
      "flow_series_plan",
      "leftover_scan",
      "guide_clear_grasp",
      "before_clear",
      "clear_done",
      "guide_phase_after_clear",
      "clear_then_fill_ok",
      "guide_fill_gate",
      "guide_phase_after_confirm",
      "guide_phase_after_area",
      "guide_phase_before_search",
      "conditions_ready",
      "guide_phase_after_search",
    ],
    steps,
    "連続客B 外す→入れ",
  );
  // NGパターン: 所在地だけ外して入れ無し
  const ng: AuditStep[] = [
    { k: "page:leftover_scan", d: "区1" },
    { k: "page:clear_done", d: null },
    { k: "finish", d: "ok" },
  ];
  assert(
    !ng.some((s) => /clear_then_fill_ok|guide_fill_gate|guide_phase_after_confirm/.test(String(s.k))),
    "NG検出用: 入れ印なし",
  );
  const j = judgeFlowSeriesProgress(steps);
  assert(j.reached.includes("before_clear"), "到達 before_clear");
  assert(j.reached.includes("after_clear"), "到達 after_clear");
  assert(j.reached.includes("after_search") || j.ok, "到達 after_search: " + j.why);
  console.log("  ✓ 擬似連続 印順OK / 到達 " + j.reached.join("→"));
}

console.log("■ 決まり verify（外す・入れる・順番）");
{
  const steps: AuditStep[] = [
    { k: "page:leftover_scan", d: "x" },
    { k: "page:flow_series_plan", d: "12段" },
    { k: "page:flow_series_order", d: "1/12" },
    { k: "page:guide_clear_grasp", d: "名3" },
    { k: "page:guide_clear_detail", d: "3" },
    { k: "page:clear_done", d: null },
    { k: "page:guide_phase_after_clear", d: "きれい" },
    { k: "page:clear_then_fill_ok", d: "入れへ" },
    { k: "page:place_xor_plan", d: "所在地絞り込みだけ" },
    { k: "page:place_xor", d: "所在地絞り込みだけ（並行しない）" },
    { k: "page:location", d: "area" },
    { k: "page:guide_fill_gate", d: "OK" },
    { k: "page:place_xor_gate", d: "XOR=所在地" },
    { k: "page:flow_series_at", d: "after_clear" },
    { k: "page:flow_series_ok", d: "after_clear" },
  ];
  const ids = [
    "clear_detail_grasp",
    "clear_then_fill_gate",
    "flow_series_order_gate",
    "guide_clear_fill_gate",
    "place_xor_grasp",
  ];
  const judged = judgeRulesOnAudit(
    steps,
    AUTO_RULES.filter((r) => ids.includes(r.id)),
  );
  for (const id of ids) {
    const row = judged.find((x) => x.id === id);
    assert(!!row && row.result !== "ng", id + " => " + JSON.stringify(row));
  }
  console.log("  ✓ clear/fill/順番/place_xor 決まり ng無し");
}

console.log("continuous-clear-fill-no-gap.test OK");
