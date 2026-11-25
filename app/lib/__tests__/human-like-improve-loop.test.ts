/**
 * 人間らしさ改善周回の計画（測る→学ぶ→再測）
 * npx tsx app/lib/__tests__/human-like-improve-loop.test.ts
 */
import {
  HUMAN_LIKE_IMPROVE_ALLOW,
  buildHumanLikeImprovePlan,
  learnGapPaceFromNormalGaps,
  evaluateHumanLikeImproveStamp,
  pickNearnessForImprove,
  pickPointPctForImprove,
} from "../human-like-improve-loop";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(HUMAN_LIKE_IMPROVE_ALLOW.nearnessMin === 70, "near 70");
assert(HUMAN_LIKE_IMPROVE_ALLOW.fast400Max === 12, "fast 12");
assert(HUMAN_LIKE_IMPROVE_ALLOW.pointMin === 60, "point 60");

{
  const ok = buildHumanLikeImprovePlan({
    nearnessScore: 80,
    fast400pct: 8,
    humanBandPct: 55,
    pointPct: 65,
    cursorPct: 75,
  });
  assert(ok.ok && ok.phase === "ok", "all good");
  assert(ok.cycle.length === 0, "no tasks");
}

{
  const p = buildHumanLikeImprovePlan({
    nearnessScore: 50,
    fast400pct: 28.5,
    humanBandPct: 21.5,
    pointPct: 5,
    cursorPct: 69,
    unreadNormal: 80,
  });
  assert(!p.ok, "not ok");
  assert(p.phase === "need_ext_spacing", "spacing first got " + p.phase);
  assert(p.cycle.some((t) => t.kind === "reflect_auto" && /gaps|間隔/.test(t.what)), "gaps to bundle first");
  assert(p.cycle.some((t) => t.kind === "need_ext_reload"), "reload");
  assert(p.cycle.filter((t) => t.kind === "photo_learn").length >= 2, "point + sequence photo");
  assert(p.cycle.some((t) => t.kind === "photo_learn" && t.order === "sequence"), "sequence learn");
  assert(p.photo_limit >= 24 && p.photo_limit <= 120, "limit " + p.photo_limit);
  const pl = p.cycle.find((t) => t.kind === "photo_learn" && t.order === "newest")!;
  assert(!!pl.fields?.length, "focus fields");
  assert(p.cycle.some((t) => t.kind === "verify_improve"), "verify");
}

{
  const onlyPoint = buildHumanLikeImprovePlan({
    nearnessScore: 75,
    fast400pct: 10,
    humanBandPct: 55,
    pointPct: 5,
    cursorPct: 80,
    unreadNormal: 40,
  });
  assert(onlyPoint.phase === "photo_learn_point", "point phase");
  assert(!onlyPoint.cycle.some((t) => t.kind === "need_ext_reload" && /間隔寄せ/.test(t.what)), "no spacing first when spacing ok");
  assert(!onlyPoint.cycle.some((t) => t.order === "sequence"), "no seq when spacing ok");
}

{
  const pace = learnGapPaceFromNormalGaps(Array.from({ length: 40 }, (_, i) => 900 + (i % 8) * 100));
  assert(!!pace && pace.median_ms >= 900 && pace.samples === 40, "pace from normal");
  assert(pace!.floor_ms >= 900 && pace!.floor_ms <= 1800, "floor " + pace!.floor_ms);
  assert(learnGapPaceFromNormalGaps([100, 200]) === null, "too few");
  // 帯外の長い中央 → 拡張向け中央は human帯へ
  const long = learnGapPaceFromNormalGaps(Array.from({ length: 30 }, () => 2500 + Math.floor(Math.random() * 200)));
  assert(!!long && long.median_ms >= 1000 && long.median_ms <= 1700, "ext median in band " + long?.median_ms);
}

{
  const ev = evaluateHumanLikeImproveStamp({
    nearness_raw: { score: 50, fast: 28, hb: 21, allowed: false, gN: 400 },
    point_pct: 5,
    cursor_pct: 69,
  });
  assert(!ev.ok && /yes-cost|再測|次/.test(ev.next), "stamp next " + ev.next);
}

{
  const foldOk = pickNearnessForImprove(
    { score: 50, fast: 28.5, hb: 21.5, gN: 400 },
    { score: 78, fast: 1.8, hb: 55, gN: 80 },
  );
  assert(foldOk.source === "fold" && foldOk.nearnessScore === 78, "prefer fold when n≥20");
  const rawOnly = pickNearnessForImprove(
    { score: 50, fast: 28, hb: 21, gN: 40 },
    { score: 90, fast: 1, hb: 60, gN: 5 },
  );
  assert(rawOnly.source === "raw" && rawOnly.nearnessScore === 50, "raw when fold thin");
}

{
  const a = pickPointPctForImprove(72, 5, 40);
  assert(a.source === "auto" && a.pointPct === 72, "auto point");
  const b = pickPointPctForImprove(null, 5, 0);
  assert(b.source === "bundle" && b.pointPct === 5, "bundle fallback");
}

{
  // 生は未達でも畳みが許可なら間隔課題を消す（計画の主が畳み）
  const ev = evaluateHumanLikeImproveStamp({
    nearness_raw: { score: 50, fast: 28.5, hb: 21.5, allowed: false, gN: 400 },
    nearness_fold: { score: 78, fast: 1.8, hb: 55, allowed: true, gN: 80 },
    point_pct: 65,
    cursor_pct: 75,
  });
  assert(ev.ok, "fold clears spacing+point " + ev.line);
}

console.log("human-like-improve-loop.test OK");
