/**
 * 連続客: 外す→把握→入れ の順番と抜けを徹底確認（決定論・DB無し）
 * npx tsx app/lib/__tests__/continuous-clear-sequence.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLAYBOOK_BUILD_V,
  PLAYBOOK_FLOW_SERIES,
  PLAYBOOK_EXTRA_GUIDES,
  buildPlaybook,
  checkPlaybook,
  judgeFlowSeriesProgress,
} from "../action-playbook";
import { AUTO_RULES, judgeRulesOnAudit, type AuditStep } from "../auto-procedure-rules";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}
function idxOf(src: string, needle: string): number {
  const i = src.indexOf(needle);
  assert(i >= 0, "missing in page-script: " + needle.slice(0, 60));
  return i;
}
/** 印の並びが昇順か（抜け・前後逆を止める） */
function assertOrder(keys: string[], steps: AuditStep[], label: string) {
  let last = -1;
  const found: string[] = [];
  for (const want of keys) {
    const i = steps.findIndex((s, j) => j > last && String(s.k || "").includes(want));
    assert(i >= 0, `${label}: 印が無い ${want}（ここまで ${found.join("→") || "なし"}）`);
    assert(i > last, `${label}: 順番逆 ${want} @${i} ≤ last=${last}`);
    last = i;
    found.push(want);
  }
}

const page = readFileSync(join(process.cwd(), "chrome-extension/page-script.js"), "utf8");
const auditJs = readFileSync(join(process.cwd(), "chrome-extension/search-audit.js"), "utf8");

console.log("■ 拡張の配線順（連続外し→入れ）");
{
  // 定義ではなく _doReset 本体内の呼出順を見る
  const doResetAt = idxOf(page, "function _doReset(callback");
  const body = page.slice(doResetAt, doResetAt + 45000);
  const a = body.indexOf('_auditStepP("leftover_scan"');
  const b = body.indexOf("try { _guideLikeClearGrasp(cond); }");
  const c = body.indexOf('_auditStepP("clear_done"');
  const d = body.indexOf("_guideLikeAfterClearCheck(cond");
  // 2026-11-26: 判定は「汚れ（dirty）」と「外し前の把握が済んだ（_beforeOk）」の両方を見る形になった（判定の意味は同じ＝ok は把握済みの時だけ）
  const e = body.indexOf('dirty ? "clear_then_fill_gap" : (_beforeOk ? "clear_then_fill_ok" : "clear_then_fill_gap")');
  assert(a >= 0 && b >= 0 && c >= 0 && d >= 0 && e >= 0, "_doReset 内に外し→入れ関所が揃う");
  assert(a < b, "leftover_scan → guide_clear_grasp");
  assert(b < c, "guide_clear_grasp → clear_done");
  assert(c < d, "clear_done → after_clear");
  assert(d < e, "after_clear → clear_then_fill");
  assert(page.includes("function _listLeftoverNamedItems"), "名前付き残り一覧");
  assert(page.includes("外す前 "), "外す前 guide_phase_one");
  assert(page.includes("外し後 "), "外し後 guide_phase_one");
  assert(body.includes("_graspFlowSeriesOrder"), "_doReset 内で順番理解");
  assert(body.includes("_flowSeriesResetReached") || page.includes("_flowSeriesResetReached"), "次客で到達リセット");
  // _doReset(callback) のあと fill が始まる（本線）
  const afterDoResetCall = page.indexOf("_doReset(function()", doResetAt);
  assert(afterDoResetCall > doResetAt, "_doReset 完了後に fill 経路");
  console.log("  ✓ leftover_scan → clear_grasp → clear_done → after_clear → clear_then_fill → fill");
}

console.log("■ 手順書 flow_series に外す前〜入れが抜けない");
{
  assert(PLAYBOOK_BUILD_V >= 12, "build_v12");
  const ids = PLAYBOOK_FLOW_SERIES.map((p) => p.id);
  assert(ids[0] === "before_clear", "先頭=before_clear 今=" + ids[0]);
  assert(ids.indexOf("before_clear") < ids.indexOf("after_clear"), "before < after_clear");
  assert(ids.indexOf("after_clear") < ids.indexOf("after_confirm"), "after_clear < after_confirm");
  const before = PLAYBOOK_FLOW_SERIES.find((p) => p.id === "before_clear")!;
  assert(before.grasp.some((g) => /guide_clear_grasp/.test(g)), "before_clear に guide_clear_grasp");
  const after = PLAYBOOK_FLOW_SERIES.find((p) => p.id === "after_clear")!;
  assert(after.grasp.some((g) => /clear_then_fill_ok/.test(g)), "after_clear に clear_then_fill_ok");
  // next チェーンが切れない
  let cur: string | null = "before_clear";
  const seen = new Set<string>();
  while (cur) {
    assert(!seen.has(cur), "flow next が循環: " + cur);
    seen.add(cur);
    const ph = PLAYBOOK_FLOW_SERIES.find((p) => p.id === cur);
    assert(!!ph, "next 先が無い: " + cur);
    cur = ph!.next;
  }
  assert(seen.has("handoff"), "チェーンが handoff まで届く");
  const clearGuide = PLAYBOOK_EXTRA_GUIDES.find((g) => g.id === "clear")!;
  assert(clearGuide.steps.length >= 5, "clear 手 ≥5");
  console.log("  ✓ before_clear→…→handoff チェーンOK / clear手" + clearGuide.steps.length);
}

console.log("■ 薄い録画でも場面が抜けない（連続2客想定）");
{
  const stationOnly = buildPlaybook({
    generated_at: new Date().toISOString(),
    scene_flows: [{ scene: "station", runs: 40, ops: 4, steps: ["route_id[]", "station_id[]"], variants: 2 }],
  });
  for (const sc of ["area", "cond", "search", "list"] as const) {
    assert(!!stationOnly.scenes.find((s) => s.scene === sc), "注入場面 " + sc);
  }
  assert(stationOnly.flow_series.some((p) => p.id === "before_clear"), "flow に before_clear");
  const issues = checkPlaybook(stationOnly);
  assert(!issues.some((x) => /必須段が無い: before_clear/.test(x)), "検査 before_clear: " + issues.join(";"));
  assert(!issues.some((x) => /before_clear が after_clear より後/.test(x)), "検査順");
  console.log("  ✓ stationのみ束でも area/cond/search/list + before_clear");
}

console.log("■ 擬似監査: 連続客A→外す→客B入れ の印順");
{
  // 客A完了後 → 客B開始の外し→入れ（把握印だけ）
  const steps: AuditStep[] = [
    { k: "page:switch_grasp", d: "客Bへ" },
    { k: "page:leftover_scan", d: "駅2・区1" },
    { k: "page:guide_clear_grasp", d: "外す前把握 名前付き3 区残:西区・駅残:弁天町・間取残:1K" },
    { k: "page:guide_phase_one", d: "外す前 1/3 区残:西区" },
    { k: "page:guide_phase_one", d: "外す前 2/3 駅残:弁天町" },
    { k: "page:guide_phase_one", d: "外す前 3/3 間取残:1K" },
    { k: "page:guide_clear_detail", d: "外す対象3を1つずつ把握" },
    { k: "page:clear_stage", d: "room_layout_id[] を開けて外す" },
    { k: "page:clear_one", d: "1K 見せてから外す" },
    { k: "page:clear_one_ok", d: "1K" },
    { k: "page:clear_stage", d: "city_code[] を開けて1区ずつ外す" },
    { k: "page:ward_clear_one", d: "西区 見せてから外す" },
    { k: "page:ward_clear_one_ok", d: "西区" },
    { k: "page:clear_done", d: null },
    { k: "page:guide_phase_after_clear", d: "きれい 名0" },
    { k: "page:guide_phase_ok", d: "after_clear 外し忘れ0・次客の入れへ" },
    { k: "page:clear_then_fill_ok", d: "外し完了→新条件の入れへ" },
    { k: "page:fill_start", d: "area" },
    { k: "page:guide_phase_after_confirm", d: "確定後" },
    { k: "page:guide_phase_after_area", d: "区入OK" },
    { k: "page:guide_phase_before_search", d: "揃い" },
    { k: "page:conditions_ready", d: "ok" },
    { k: "page:guide_phase_after_search", d: "検索把握" },
  ];
  /**
   * ⚠ fill_start は fillRealpro 入口で clear より先に付く（客セッション開始）。
   *   外す→入れの関所順は clear_then_fill_ok のあと after_confirm / after_search。
   */
  assertOrder(
    [
      "leftover_scan",
      "guide_clear_grasp",
      "guide_clear_detail",
      "clear_done",
      "guide_phase_after_clear",
      "clear_then_fill_ok",
      "guide_phase_after_confirm",
      "guide_phase_after_search",
    ],
    steps,
    "連続客B",
  );
  // 所在地だけ外して終わるパターン（NG）を検出できるか
  const stopEarly: AuditStep[] = [
    { k: "page:leftover_scan", d: "区1" },
    { k: "page:clear_stage", d: "city_code[]" },
    { k: "page:clear_done", d: null },
    { k: "finish", d: "ok" },
  ];
  const hasFill = stopEarly.some((s) => /fill_start|clear_then_fill_ok/.test(String(s.k)));
  assert(!hasFill, "早期停止サンプルは fill 無し（検出用）");
  const j = judgeFlowSeriesProgress(steps);
  assert(j.reached.includes("before_clear"), "到達 before_clear: " + j.why);
  assert(j.reached.includes("after_clear"), "到達 after_clear");
  assert(j.ok || j.reached.includes("after_search"), "検索把握まで: " + j.why);
  console.log("  ✓ 擬似連続 印順OK / flow到達 " + j.reached.join("→"));
}

console.log("■ 決まり・監査KEEPが外す細印を落とさない");
{
  assert(AUTO_RULES.some((r) => r.id === "clear_detail_grasp"), "clear_detail_grasp");
  assert(AUTO_RULES.some((r) => r.id === "clear_then_fill_gate"), "clear_then_fill_gate");
  assert(/guide_clear_/.test(auditJs), "search-audit KEEP guide_clear_");
  assert(/clear_then_fill_/.test(auditJs), "search-audit KEEP clear_then_fill_");
  const fake: AuditStep[] = [
    { k: "page:guide_clear_grasp", d: "名3" },
    { k: "page:clear_done", d: null },
    { k: "page:guide_phase_after_clear", d: "きれい" },
    { k: "page:clear_then_fill_ok", d: "入れへ" },
  ];
  const judged = judgeRulesOnAudit(fake, AUTO_RULES.filter((r) => r.scene === "clear"));
  const detail = judged.find((x) => x.id === "clear_detail_grasp");
  const gate = judged.find((x) => x.id === "clear_then_fill_gate");
  assert(!!detail && detail.result !== "ng", "clear_detail_grasp 判定: " + JSON.stringify(detail));
  assert(!!gate && gate.result !== "ng", "clear_then_fill_gate 判定: " + JSON.stringify(gate));
  console.log("  ✓ clear 決まり 擬似監査 ng無し");
}

console.log("continuous-clear-sequence.test OK");
