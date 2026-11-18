// F53 画像連続流れの純関数（DB無し）
// 実行: npx tsx app/lib/__tests__/foundation-f53-image-seq.test.ts
import {
  shotKeyRunId,
  isShotLearnOk,
  shotLearnHasSceneFlow,
  countSeqCoveredRuns,
} from "../learn-foundation-audit";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
};

const key = (run: string) => `2026-11-16/normal/${run}/x.jpg`;

console.log("■ shotKeyRunId");
ok("run を抜く", shotKeyRunId(key("run_abc_sq1")) === "run_abc_sq1");
ok("無いとき null", shotKeyRunId("no-run.jpg") === null);

console.log("\n■ isShotLearnOk / scene");
ok("fields ありは learned", isShotLearnOk({ screen: "form", fields: [] }));
ok("error は除外", !isShotLearnOk({ error: "vision_fail" }));
ok("scene station", shotLearnHasSceneFlow({ scene: "station", screen: "form" }));
ok("scene other のみは無", !shotLearnHasSceneFlow({ scene: "other", screen: "form" }));
ok("flow_step あり", shotLearnHasSceneFlow({ scene: "other", flow_step: "駅を選ぶ" }));

console.log("\n■ countSeqCoveredRuns");
{
  const sl = { screen: "form", fields: [], scene: "cond" };
  const rows = [
    ...Array.from({ length: 8 }, () => ({ shot_key: key("run_ok_a"), shot_learn: sl })),
    ...Array.from({ length: 4 }, () => ({ shot_key: key("run_ok_a"), shot_learn: null })),
    ...Array.from({ length: 3 }, () => ({ shot_key: key("run_thin_b"), shot_learn: sl })),
    { shot_key: "flat.jpg", shot_learn: sl },
  ];
  const n = countSeqCoveredRuns(rows);
  ok("learned>=5 かつ ratio>=0.25 の run が 1", n === 1);
  ok("薄い run は数えない", countSeqCoveredRuns(rows, 5, 0.25) === 1);

  const longRun = [
    ...Array.from({ length: 6 }, () => ({ shot_key: key("run_long_ok"), shot_learn: { screen: "modal", fields: [], scene: "area" } })),
    ...Array.from({ length: 6 }, () => ({ shot_key: key("run_long_ok"), shot_learn: { screen: "result", fields: [], scene: "list" } })),
    ...Array.from({ length: 200 }, () => ({ shot_key: key("run_long_ok"), shot_learn: null })),
  ];
  ok("長尺ランは2場面+learned>=12で連続カバー✓", countSeqCoveredRuns(longRun) === 1);
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);