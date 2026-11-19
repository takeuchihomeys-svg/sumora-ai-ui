/**
 * 束の最上位に写真の学習の抜け（shot_gaps / shot_gaps_normal）が載る（2026-11-19）
 * 実行: npx tsx app/lib/__tests__/bundle-shot-gaps.test.ts
 */
import { buildHumanLearnBundle, compactBundle } from "../human-learn-brain";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail ?? ""); }
}

console.log("■ 束に学べ済みが載る");
{
  const rows = [
    { site: "realpro", mode: "normal", shot_key: "a1", shot_taken: true, shot_w: 1920, shot_learn: { fields: [{ name: "検索", kind: "button" }] } },
    { site: "realpro", mode: "normal", shot_key: "a2", shot_taken: true, shot_w: 1920, shot_learn: { fields: [{ name: "賃料", kind: "select" }] } },
    { site: "realpro", mode: "normal", shot_key: "a3", shot_taken: true, shot_w: 1920 },
    { site: "realpro", mode: "auto", shot_key: "a4", shot_taken: true, shot_w: 1920, shot_learn: { fields: [{ name: "検索", kind: "button" }] } },
  ];
  const b = compactBundle(buildHumanLearnBundle(rows as never));
  ok("shot_gaps_normal: 学べ2・未読1", b.shot_gaps_normal?.learnedOk === 2 && b.shot_gaps_normal?.todo === 1, b.shot_gaps_normal);
  ok("shot_gaps: 学べ3", b.shot_gaps?.learnedOk === 3, b.shot_gaps);
}

console.log("■ 写真が無ければ載せない");
{
  const b = compactBundle(buildHumanLearnBundle([{ site: "realpro", mode: "normal" }] as never));
  ok("shot_gaps なし", b.shot_gaps === undefined && b.shot_gaps_normal === undefined);
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
