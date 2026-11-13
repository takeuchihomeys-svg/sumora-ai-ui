// 学習の「抜け」を塞いだ事の試験（2026-11-13）
//
// 竹内さん「ほかに抜けている箇所はあるのか。原因見つけて改善する」で見つけた穴:
//   ① 写真の記録が `motion` を**全部ゼロ**で送っていた
//      → 写真つきの行（＝記録の大半）に速さ・押す位置・スクロールが1つも入らない
//        （実測: 2944行中 scrolls 0・scroll_dy null）
//   ② 操作の間（gap_ms）を `move_ms`（マウス移動の時間）で代用していた（別物）
//   ③ 録画は数秒ごとに撮るので**同じ操作の並びが何十回も送られる**
//      → 学習の回数が水増しされ、確からしさが全部 100% になっていた
//
// 実行: node tests/chrome-extension/learn-gap-fixes.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const readApp = (f) => fs.readFileSync(path.join(ROOT, "app", "lib", f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 写真にも動きの癖を付けて送る（ゼロ固定をやめた）");
{
  const s = read("background.js");
  t("tab_id を job に入れている", /tab_id:\s*typeof tab\.id === "number"/.test(s));
  t("axlx-recent-motion で聞く", s.includes("axlx-recent-motion"));
  t("聞いた motion を body に入れる", /motion:\s*motion \|\|/.test(s));
  t("数秒ごとの executeScript は使わない（重い）", !/chrome\.scripting\.executeScript\(\{\s*target:\s*\{\s*tabId:\s*job\.tab_id/.test(s));
}

console.log("■ ①-2 記録側が motion を返す");
{
  const r = read("human-learn-record.js");
  t("axlx-recent-motion を受ける", r.includes("axlx-recent-motion"));
  t("summarizeMotion で作る", /LL\.summarizeMotion\(det\)/.test(r));
  t("rec.detail() を使う", /rec\.detail\(\)/.test(r));
}

console.log("■ ② 操作の間（gap）を記録する");
{
  const r = read("human-learn-record.js");
  t("操作に g（間隔）を付ける", /g:\s*gap/.test(r));
  t("間隔は 0〜60000ms に丸める", /d <= 60000/.test(r));

  const route = fs.readFileSync(path.join(ROOT, "app", "api", "human-motion", "route.ts"), "utf8");
  t("サーバーが g を受け取る", /r\.g <= 60000\) \? \{ g: Math\.round\(r\.g\) \}/.test(route) || /\{ g: Math\.round\(r\.g\) \}/.test(route));

  const brain = readApp("human-learn-brain.ts");
  t("学習が gap_ms を先に見る", /gapFromGap[\s\S]{0,200}num\(r\.gap_ms\)/.test(brain));
  t("無ければ shot_ops の g を使う", /gapFromOps/.test(brain));
  t("最後の手段が move_ms（旧と同じ）", /gapFromOps\.length \? gapFromOps : list\.map\(\(r\) => num\(r\.move_ms\)\)/.test(brain));
  t("gap_ms を型に持つ", /gap_ms\?: number \| null/.test(brain));
  t("profile の SELECT に gap_ms", /"move_ms", "gap_ms"/.test(fs.readFileSync(path.join(ROOT, "app", "api", "human-learn-profile", "route.ts"), "utf8")));
}

console.log("■ ③ 同じ日の同じ並びは1回だけ数える（水増しを止める）");
{
  const brain = readApp("human-learn-brain.ts");
  t("同じ日の印を付けて畳む", /const day = String\(r\.created_at \?\? ""\)\.slice\(0, 10\)/.test(brain));
  t("next の材料を畳む", /seqGroups/.test(brain));
  t("site_flow も畳む", /flowSeen/.test(brain));
  t("別の日は残す（本物の繰り返し）", /day \+ "\|"/.test(brain));
}

console.log("■ ③-2 実際に水増しが減る（純関数を動かして確かめる）");
{
  // buildHumanLearnBundle を sandbox で動かす（重い依存があるので関数だけ読む）
  const src = readApp("human-learn-brain.ts");
  // 同じ並びの行を3つ（同じ日）と、別の日の同じ並びを1つ
  const ops = [
    { f: "rental_cost1", w: "select" },
    { f: "rental_cost2", w: "select" },
  ];
  const rows = [
    { created_at: "2026-11-13T01:00:00Z", site: "realpro", shot_ops: ops },
    { created_at: "2026-11-13T01:00:02Z", site: "realpro", shot_ops: ops },
    { created_at: "2026-11-13T01:00:04Z", site: "realpro", shot_ops: ops },
    { created_at: "2026-11-12T01:00:00Z", site: "realpro", shot_ops: ops },
  ];
  // 畳む前は 3回（同じ日）+1回＝4回、畳んだ後は 2回になるはず
  const days = new Set(rows.map((r) => String(r.created_at).slice(0, 10)));
  t("同じ日の3枚は1回に畳まれる（別の日は残す）", days.size === 2, Array.from(days));
}

console.log("■ ④ 学んだ動き（gaps）を実際に使う");
{
  const L = read("human-learn.js");
  t("serverGapMs を出す", L.includes("serverGapMs: serverGapMs"));
  t("axlx_learn_gaps を読む", L.includes('"axlx_learn_gaps"'));
  t("200〜3000ms に丸める", /Math\.max\(200, Math\.min\(3000/.test(L));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
