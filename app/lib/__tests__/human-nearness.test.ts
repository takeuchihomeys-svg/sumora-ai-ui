/**
 * 人間との近さ（間隔）— 機械っぽい短間隔 vs 人間帯
 * npx tsx app/lib/__tests__/human-nearness.test.ts
 */
import {
  NEARNESS_ALLOW,
  bucketGaps,
  computeHumanNearness,
  gapsFromOps,
  pressGapsFromRows,
  scoreNearness,
} from "../human-nearness";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(NEARNESS_ALLOW.scoreMin === 70, "scoreMin 70");
assert(NEARNESS_ALLOW.fast400MaxPct === 12, "fast400 ≤12%");
assert(NEARNESS_ALLOW.humanBandMinPct === 50, "human帯 ≥50%");

// change/diag の短 g は動作間隔に入れない
{
  const gs = gapsFromOps([
    { k: "click", g: 900 },
    { k: "change", g: 20 },
    { k: "diag", g: 1 },
    { k: "tap", g: 1100 },
    { k: "key", g: 800 },
  ]);
  assert(gs.length === 3 && gs[0] === 900 && gs[1] === 1100 && gs[2] === 800, "gapsFromOps click/tap/key only");
}

// 人間帯の標本（固定値・揺れなし）→ 短間隔少なく human帯が高い
{
  const human = Array.from({ length: 40 }, (_, i) => 900 + (i % 8) * 100); // 900–1600
  const autoLike = Array.from({ length: 40 }, (_, i) => 850 + (i % 9) * 100);
  const n = computeHumanNearness({ normalGaps: human, autoGaps: autoLike, nowMs: 1 });
  assert(n.auto.gN === 40 && n.normal.gN === 40, "sample size");
  assert((n.auto.fast400pct ?? 100) <= 12, "human-like not too fast " + n.auto.fast400pct);
  assert((n.auto.humanBandPct ?? 0) >= 50, "human band " + n.auto.humanBandPct);
  assert(n.score.total >= 50, "score somewhat near " + n.score.total);
}

// 機械っぽい連打（全部 <400ms）→ 短間隔で未達
{
  const human = Array.from({ length: 40 }, () => 1000);
  const machine = Array.from({ length: 40 }, (_, i) => 40 + (i % 5) * 10);
  const n = computeHumanNearness({ normalGaps: human, autoGaps: machine, nowMs: 1 });
  assert(!n.allowed, "machine not allowed");
  assert(n.gaps.some((g) => /短間隔/.test(g)), "gap names fast " + n.gaps.join("/"));
  assert((n.auto.fast400pct ?? 0) > NEARNESS_ALLOW.fast400MaxPct, "fast pct high");
}

// 畳み: 300ms以内の連続 click は1押下
{
  const rows = [
    {
      install_id: "i1",
      mode: "brain_aix",
      shot_ops: [
        { t: 1000, k: "click", f: "a", g: 0 },
        { t: 1100, k: "click", f: "a", g: 100 }, // 同じ押下の別経路
        { t: 2000, k: "click", f: "b", g: 900 },
      ],
    },
  ];
  const st = pressGapsFromRows(rows, () => "auto");
  assert(st.auto.presses === 2, "fold to 2 presses got " + st.auto.presses);
  assert(st.auto.gaps.length === 1 && st.auto.gaps[0] === 1000, "gap between heads " + JSON.stringify(st.auto.gaps));
}

{
  const a = bucketGaps([100, 200, 1500, 1600, 1700]);
  const h = bucketGaps([1000, 1100, 1200, 1300, 1400]);
  const s = scoreNearness(a, h);
  assert(typeof s.total === "number" && s.total >= 0 && s.total <= 100, "score range");
}

console.log("human-nearness.test OK");
