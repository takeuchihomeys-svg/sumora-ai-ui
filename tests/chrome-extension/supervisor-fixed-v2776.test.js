// tests/chrome-extension/supervisor-fixed-v2776.test.js
// 実行: node tests/chrome-extension/supervisor-fixed-v2776.test.js
// 2026-11-15 竹内さん「ほかにも統括が連携弱い部分等あれば土台作って強化する」
//   「学習も弱い部分を見つけて強化できるようにするために」「実際の人間の動きのようになるために」
//
//   ★ 実測で見つけた3つの弱さ
//     ① 統括が判断しても現場で実行されていない
//        現場への指示（直近100件）: pending 61・error 39・**誰も拾っていない 0件**。
//        失敗理由は39回とも「AIXモードのPCが3時間なかったため未実行で終了」。
//     ② **同じ指摘を出し続けている**（「欄の種類が分からない」が 1,241回）
//        ⚠ ところが**直近の束では全部判定済み**（photo 26・name 32・なし5）。
//        ＝ もう直っているのに、統括は過去の記録を数え続けて同じ事を言っていた。
//     ③ 強化の実績（learn_improvements）が古い
//
//   → ①②の土台を作った:
//     ・`scripts/audit-supervisor-loop.ts` … 判断→実行→確認を1つの表にして**切れを数で**出す
//     ・統括が**前回と比べて**「直った（前回あって今回無い）」「まだ（両方ある）」を分ける
//     ・`meeting.weak_list` に今回の弱い所を残す（次回が比べられる）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..");
const sup = fs.readFileSync(path.join(dir, "app", "lib", "learn-supervisor.ts"), "utf8");
const db = fs.readFileSync(path.join(dir, "app", "lib", "learn-supervisor-db.ts"), "utf8");
const api = fs.readFileSync(path.join(dir, "app", "api", "human-learn-profile", "route.ts"), "utf8");
const loop = fs.readFileSync(path.join(dir, "scripts", "audit-supervisor-loop.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① 統括が「直った」を判定できる");
{
  ok("  前回の弱い所を prevWeak で受け取る", /prevWeak/.test(sup));
  ok("  ⚠ 前回あって今回無い＝直った（fixedWeak）", /const fixedWeak = prevKeys\.size/.test(sup));
  ok("  ⚠ 両方ある＝まだ直っていない（ongoingKeys）", /const ongoingKeys = new Set\(\[\.\.\.prevKeys\]\.filter/.test(sup));
  ok("  ⚠ まだ直っていない物は優先度を上げる", /f\.priority - \(isOngoing \? 1 : 0\)/.test(sup));
  ok("  言葉に「前回から直った事」を出す", /前回から直った事/.test(sup));
  ok("  言葉に「前回も同じ指摘」を出す", /前回も同じ指摘/.test(sup));
  ok("  戻り値に fixed / ongoing を入れる", /fixed: fixedWeak/.test(sup) && /ongoing: ongoingKeys\.size/.test(sup));
  ok("  ⚠ 前回が無い時は比べない（初回）", /inp\.prev && Array\.isArray\(inp\.prev\.prevWeak\) \? inp\.prev\.prevWeak : \[\]/.test(sup));
}

console.log("\n■ ② 次回が比べられるように weak_list を残す");
{
  ok("  meeting.weak_list に入れる", /weak_list/.test(db));
  ok("  ⚠ kind と name だけ（長文は入れない・大きさを抑える）", /kind: String\(x\.kind \?\? ""\)\.slice\(0, 30\), name: String\(x\.name \?\? ""\)\.slice\(0, 40\)/.test(db));
  ok("  最大40件", /\.slice\(0, 40\)/.test(db));
  ok("  ⚠ 既存の meeting を消さない（上書きしない）", /const base = m \? \{ \.\.\.m \} : \{\}/.test(db));
}

console.log("\n■ ③ API が前回の弱い所を渡す");
{
  ok("  meeting を読んでいる", /select\("created_at, next_n, points_n, opens_n, weak_n, rows, meeting"\)/.test(api));
  ok("  ⚠ meeting.weak_list から取り出す", /weak_list/.test(api));
  ok("  ⚠ 旧い記録（weak_list が無い）は null（比べない）", /prevWeak = null/.test(api));
  ok("  ⚠ 壊れたデータは空にする（誤判定しない）", /catch \(_\) \{ prevWeak = null; \}/.test(api));
}

console.log("\n■ ④ 「判断→実行→確認」の輪を測る土台");
{
  ok("  audit-supervisor-loop.ts がある", /統括の「判断 → 実行 → 確認」の輪/.test(loop));
  ok("  ① 統括の判断を数える", /統括の判断/.test(loop));
  ok("  ② 現場の指示（拾われたか）を数える", /誰かが拾った/.test(loop));
  ok("  ③ 強化の実績を数える", /強化の実績/.test(loop));
  ok("  ⚠ 輪が切れている所を名指しする", /輪が切れている所/.test(loop));
  ok("  ⚠ 指示が拾われていない事を検出", /指示が拾われていない/.test(loop));
  ok("  ⚠ 同じ指摘を出し続けている事を検出", /同じ指摘を出し続けている/.test(loop));
  ok("  ⚠ 強化の実績が0件を検出", /強化の実績が.*0件/.test(loop));
  ok("  次にやる事を優先順で出す", /次にやる事（この順）/.test(loop));
}

console.log("\n■ ⑤ 実測した事実をコメントに残している（次に同じ調査をしない）");
{
  ok("  ⚠ 1,241回を記録", /1,241回|1241回/.test(sup));
  ok("  ⚠ 直近の束では全部判定済みと記録", /photo 26個・name 32個/.test(sup));
  ok("  ⚠ AIXモードのPCが3時間なかったを記録", /AIXモードのPCが3時間なかった/.test(loop));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
