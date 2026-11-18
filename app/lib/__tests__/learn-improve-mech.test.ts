// 学習改善を欄×観点で細かく回す仕組み（2026-11-16）
// 実行: npx tsx app/lib/__tests__/learn-improve-mech.test.ts
import {
  DETAIL_DEGREE,
  FACET_JA,
  detailDegreeLine,
  fineGapsForField,
  detectAutoControlSlips,
  detectPlaceNotRedone,
  detectSearchBeforeBasic,
  detectSearchBeforePlace,
  fineGapsToTaskHints,
  fineLearnEvidenceLine,
  fineLearnNextSteps,
  measureAutoCompletion,
  measurePrecision,
  precisionEvidenceLine,
  precisionLeversLinked,
  scoreFieldsFine,
  supervisorLearnPower,
  weakDetailFields,
} from "../learn-improve-mech";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 既知selectは種類再判定せず位置・押して変化へ");
{
  const gaps = fineGapsForField("rental_cost2", {
    fields: ["rental_cost2"],
    directWriteFields: ["rental_cost2"],
    cursorPct: 50,
    pointPct: 20,
    handClicks: 0,
  });
  ok("種類(kind)抜けが無い（仕組み①）", !gaps.some((g) => g.facet === "kind"), gaps.map((g) => g.facet));
  ok("位置の抜けがある", gaps.some((g) => g.facet === "position"));
  ok("押して変化の抜けがある", gaps.some((g) => g.facet === "click_change"));
  ok("位置 how に仕組み①", /仕組み①|select/.test(gaps.find((g) => g.facet === "position")?.how || ""));
}

console.log("\n■ ② 区は外し/選び観点が出る");
{
  const gaps = fineGapsForField("city_code[]", {
    fields: ["city_code[]"],
    reclickFields: ["city_code[]"],
    toggleOff: 0,
    toggleOn: 0,
    toggleUnknown: 400,
    cursorPct: 80,
    pointPct: 60,
    handClicks: 2,
    sceneLinkedFields: ["city_code[]"],
  });
  ok("toggle 抜け", gaps.some((g) => g.facet === "toggle"), gaps);
  ok("was/now を how に含む", /was\/now|仕組み②/.test(gaps.find((g) => g.facet === "toggle")?.how || ""));
}

console.log("\n■ ③ 複数欄の採点と次手");
{
  const st = scoreFieldsFine({
    fields: ["rental_cost2", "required_time", "city_code[]"],
    directWriteFields: ["required_time"],
    reclickFields: ["city_code[]"],
    toggleUnknown: 100,
    cursorPct: 40,
    pointPct: 20,
    handClicks: 0,
    sceneLinkedFields: ["rental_cost2"],
  });
  ok("3欄分", st.length === 3, st.length);
  ok("平均が100未満", st.every((s) => s.score <= 100) && st.some((s) => s.score < 100));
  const steps = fineLearnNextSteps(st, 5);
  ok("次手が出る", steps.length >= 3, steps.length);
  ok("優先が低い数字が先", steps[0].priority <= steps[steps.length - 1].priority);
  ok("根拠行に平均", /平均\d+%/.test(fineLearnEvidenceLine(st)), fineLearnEvidenceLine(st));
  const hints = fineGapsToTaskHints(steps);
  ok("photo_learn ヒント", hints.some((h) => h.kind === "photo_learn"), hints);
  ok("toggle なら foundation", hints.some((h) => h.kind === "build_foundation"), hints);
}

console.log("\n■ ④ 統括の学習力は仕組み適用で測る");
{
  const low = supervisorLearnPower({
    mechanismsInEvidence: true,
    photoLearnUsesSelectMech: false,
    hasFineLearnEvidence: false,
    toggleMechApplied: false,
    softCapWhenNotHuman: true,
  });
  ok("抜けがあると100未満", low.score < 100, low);
  ok("足りないラベルがある", low.missing.length >= 2, low.missing);
  const high = supervisorLearnPower({
    mechanismsInEvidence: true,
    photoLearnUsesSelectMech: true,
    hasFineLearnEvidence: true,
    toggleMechApplied: true,
    softCapWhenNotHuman: true,
    precisionLinked: true,
    weakThenImproveApplied: true,
  });
  ok("全部揃えば100", high.score === 100, high);
  ok("FACET_JA がある", FACET_JA.position === "位置");
  const noWeakImprove = supervisorLearnPower({
    mechanismsInEvidence: true,
    photoLearnUsesSelectMech: true,
    hasFineLearnEvidence: true,
    toggleMechApplied: true,
    softCapWhenNotHuman: true,
    precisionLinked: true,
    weakThenImproveApplied: false,
  });
  ok("弱い→改善なしは100未満", noWeakImprove.score < 100 && noWeakImprove.missing.some((m) => /弱い部分/.test(m)), noWeakImprove);
}

console.log("\n■ ⑤ 精度を測り、一連と連携してレバーを出す");
{
  const st = scoreFieldsFine({
    fields: ["rental_cost2", "required_time"],
    directWriteFields: ["required_time"],
    cursorPct: 40,
    pointPct: 20,
    handClicks: 0,
  });
  const p = measurePrecision({
    fineStatuses: st,
    reproducePct: 35,
    auditFinishRate: 35,
    challengeFieldCount: 4,
  });
  ok("精度が100未満", p.score < 100, p);
  ok("精度行に数字", /精度 \d+\/100/.test(p.line), p.line);

  const atBn5 = precisionLeversLinked({
    precision: p,
    fineStatuses: st,
    bottleneckN: 5,
    reproduceRemain: ["カーソル40%（要≥70）", "手の形なし（通常でボタン録画→cs）"],
  });
  ok("段階5なら自動1回が先", atBn5[0]?.kind === "need_auto_run", atBn5.map((l) => l.kind));
  ok("根拠に連携と次", /連携|次:/.test(precisionEvidenceLine(p, atBn5, 5)), precisionEvidenceLine(p, atBn5, 5));

  const atBn2 = precisionLeversLinked({
    precision: p,
    fineStatuses: st,
    bottleneckN: 2,
    reproduceRemain: [`押した位置20%（要≥${DETAIL_DEGREE.POINT_OK}）`],
  });
  ok("段階が手前なら細かく学ぶ系がある", atBn2.some((l) => l.kind === "photo_learn" || l.kind === "need_human"), atBn2.map((l) => l.kind));
}

console.log("\n■ ⑥ 自動モード完成度を測り、学習ヒントを出す");
{
  const c = measureAutoCompletion({
    improveSteps: [
      { n: 1, ok: true, name: "写真" },
      { n: 2, ok: true, name: "操作" },
      { n: 3, ok: true, name: "束" },
      { n: 4, ok: false, name: "拡張が束を読む" },
      { n: 5, ok: false, name: "自動" },
      { n: 6, ok: false, name: "効果" },
    ],
    bottleneckN: 4,
    reproducePct: 35,
    reproduceRemain: ["カーソル59%（要≥70）", "手の形なし（通常でボタン録画→cs）"],
    fineAvg: 32,
    precisionScore: 24,
    humanAutoOk: false,
    challengeN: 8,
  });
  ok("完成度が数字で出る", c.score >= 0 && c.score <= 100, c.score);
  ok("まだ完成ではない", c.score < 70 && /土台|もう少し|まだ早い/.test(c.grade), c);
  ok("行に完成度", /自動モード完成度/.test(c.line), c.line);
  ok("学習ヒントが拡張再読込", /拡張再読込|段階4/.test(c.learnHint), c.learnHint);
  ok("内訳が5パート", c.parts.length === 5, c.parts);

  const done = measureAutoCompletion({
    improveSteps: [1, 2, 3, 4, 5, 6].map((n) => ({ n, ok: true })),
    bottleneckN: null,
    reproducePct: 100,
    fineAvg: 90,
    precisionScore: 85,
    humanAutoOk: true,
    challengeN: 0,
  });
  ok("揃えば完成に近い", done.score >= 85 && done.grade === "完成に近い", done);
}

console.log("\n■ 制御ずれ検知（家賃連打・間取り抜け）");
{
  const bad = detectAutoControlSlips([
    ["確定してリストへ", "rental_cost2", "rental_cost2", "rental_cost2", "include_common_fee", "structured_date"],
    ["rental_cost2", "room_layout_id[]", "update_date"],
  ]);
  ok("家賃連続3回を検知", bad.rentMultiRuns === 1, bad);
  ok("間取り抜けを検知", bad.layoutMissRuns === 1, bad);
  ok("行に制御ずれ", /制御ずれ|家賃連続|間取り抜け/.test(bad.line), bad.line);
  const good = detectAutoControlSlips([["rental_cost2", "room_layout_id[]", "update_date"]]);
  ok("正常列はずれなし", good.rentMultiRuns === 0 && good.layoutMissRuns === 0, good);

  const early = detectSearchBeforePlace([
    "fill_start",
    "search_guard_press",
    "clear_checks",
    "location:area",
    "place_ready",
    "search",
  ]);
  ok("場所前の検索保険を検知", early.earlySearch, early);
  const okOrder = detectSearchBeforePlace([
    "fill_start",
    "location:area",
    "place_ready",
    "basic_after_place",
    "search",
  ]);
  ok("正しい順はOK", !okOrder.earlySearch, okOrder);

  const beforeBasic = detectSearchBeforeBasic([
    "fill_start",
    "search_guard_press",
    "basic_after_place",
    "gate_warn",
    "search",
  ]);
  ok("基本条件前の保険検索を検知", beforeBasic.earlySearch, beforeBasic);
  const afterBasic = detectSearchBeforeBasic([
    "place_ready",
    "basic_after_place",
    "conditions_ready",
    "search",
  ]);
  ok("conditions_ready後はOK", !afterBasic.earlySearch, afterBasic);

  const notRedone = detectPlaceNotRedone([
    "fill_start",
    "location:area",
    "place_ready",
    "search",
  ]);
  ok("やり直し印なしは弱い", notRedone.weak, notRedone);
  const redone = detectPlaceNotRedone([
    "place_redo",
    "clear_checks",
    "area_preclear_force",
    "location:area",
    "place_ready",
    "search",
  ]);
  ok("forceやり直しありはOK", !redone.weak, redone);
  const keptBug = detectPlaceNotRedone([
    "area_preclear_keep",
    "location:area",
    "place_ready",
    "search",
  ]);
  ok("人が選んだと誤残しは弱い", keptBug.weak, keptBug);
}

console.log("\n■ 細部の度・弱い欄→改善");
{
  ok("押した位置の度は60", DETAIL_DEGREE.POINT_OK === 60);
  ok("カーソルの度は70", DETAIL_DEGREE.CURSOR_OK === 70);
  const st = scoreFieldsFine({
    fields: ["rental_cost2", "required_time"],
    directWriteFields: ["rental_cost2", "required_time"],
    cursorPct: 40,
    pointPct: 20,
    handClicks: 0,
  });
  const weak = weakDetailFields(st);
  ok("弱い欄が出る", weak.length >= 1, weak);
  const line = detailDegreeLine({ cursorPct: 60, pointPct: 28, fineAvg: 26, weakFields: weak });
  ok("度の行に補強線", /要|≥60|≥70|弱い/.test(line) || /度:/.test(line), line);
  ok("位置28は未達表示", /⚠位置28/.test(line), line);
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
