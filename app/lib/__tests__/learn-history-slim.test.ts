// 引き継ぎで前の束を細く読む（2026-11-21 作業員G・#588 ②）
// 実行: npx tsx app/lib/__tests__/learn-history-slim.test.ts
import { countLearnedSolid, HISTORY_SLIM_SELECT, learnHistorySlimOn, toHistRow } from "../learn-bundle-preserve";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

const solid = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, x: 1, y: 2, n: 3 }));
const shots = { learned: { scr: solid(31) }, in_storage: 5, kinds: { a: 1 } };
const full = { shots, foundation_audit: { key: {} }, scene_flows: [{ scene: "station", steps: ["駅の設定へ進む"] }], lines: ["大きい欄"], points: { x: 1 } };

const slimRow = toHistRow({ created_at: "2026-11-21", shots, foundation_audit: full.foundation_audit, scene_flows: full.scene_flows });
ok("細く読んだ行を bundle の形に戻す（3つの欄）", JSON.stringify(Object.keys(slimRow.bundle as object).sort()) === JSON.stringify(["foundation_audit", "scene_flows", "shots"]));
ok("確かな欄の数は丸ごと読んだ時と同じ", countLearnedSolid(slimRow.bundle).solid === countLearnedSolid(full).solid && countLearnedSolid(full).solid === 31);
ok("丸ごと読んだ行はそのまま", toHistRow({ bundle: full, created_at: "x" }).bundle === full);
ok("無い欄は足さない", Object.keys(toHistRow({ created_at: "x", shots }).bundle as object).length === 1);
ok("読む欄は3つと時刻だけ", /shots:bundle->shots/.test(HISTORY_SLIM_SELECT) && !/\bbundle,/.test(HISTORY_SLIM_SELECT));
ok("既定 on", learnHistorySlimOn({}) === true && learnHistorySlimOn({ LEARN_HISTORY_SLIM: "off" }) === false);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
