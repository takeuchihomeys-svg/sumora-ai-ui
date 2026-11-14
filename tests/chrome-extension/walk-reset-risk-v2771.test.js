// tests/chrome-extension/walk-reset-risk-v2771.test.js
// 実行: node tests/chrome-extension/walk-reset-risk-v2771.test.js
// 2026-11-14 竹内さん「直近の通常モードの録画から押し方プルダウンの場所、
//   徒歩が消えないようにする部分学習して改善する」「統括おねがい」
//
//   ⚠ リアプロの仕様: **移動手段（transportation_id）を選ぶと下の分数（required_time）がリセットされる**。
//     人が「分数 → 移動手段」の順でやると分数が消える。
//
//   実測（録画 mwgf1gx3_n1k5 の一番長い操作の並び・39件を click/change で畳んで24件）:
//     左側の押した順: click transportation_id → click 分 → click transportation_id → click 大阪43棟189戸並べ替
//     ⚠ **徒歩が2回**出ている＝もう一度選び直している（分数を入れた後に消された疑い）
//
//   ⚠ 画面の欄名は `required_time` ではなく **`分`** で記録される事がある（実測）。
//     旧の判定は `required_time` しか見ていなかったので、**実測の形で指摘が出なかった**（テストで発覚）。
//
//   → 手本から「徒歩の順番の危険」を見つけて**統括の弱い所**に足す（統括が直せるように）。
//     ・分数が先 → 消える恐れ
//     ・移動手段が2回 → 選び直し（消えた証拠）
//     ・全部正しい順 → 指摘しない（無駄な指摘を出さない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(dir, "app", "lib", "learn-flow-steps.ts"), "utf8");
const brain = fs.readFileSync(path.join(dir, "app", "lib", "human-learn-brain.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

/** 本体と同じ決まりを写す（本体の文字は ■⑤ で見る） */
function findWalkResetRisk(runs) {
  let bad = 0, good = 0, twice = 0;
  for (const ops of Array.isArray(runs) ? runs : []) {
    const names = (Array.isArray(ops) ? ops : []).map((o) => String((o && o.f) || "")).filter((n) => n && n !== "undefined");
    const isWalk = (n) => /transportation_id|移動手段|交通手段/.test(n);
    const isMin = (n) => /required_time|^分$|徒歩分|徒歩時間|駅からの徒歩/.test(n);
    const iT = names.findIndex(isWalk);
    const iW = names.findIndex(isMin);
    if (iT < 0 && iW < 0) continue;
    if (names.filter(isWalk).length >= 2) twice++;
    if (iT >= 0 && iW >= 0) { if (iW < iT) bad++; else good++; }
  }
  const total = bad + good;
  if (!total && !twice) return null;
  if (total && bad === 0 && twice === 0) return null;
  const why = bad
    ? `分数を入れてから移動手段を選んでいる手本が ${bad}/${total}件あります（移動手段を選ぶと分数がリセットされる）`
    : `移動手段を2回以上選んでいる手本が ${twice}件あります（選び直し＝分数が消えた疑い）`;
  return {
    kind: "walk_reset",
    why,
    next: "手順を「移動手段 → 分数」の順に固定する（自動は既に固定済み。人の案内も同じ順にする）",
  };
}

console.log("■ ① 実測の形（徒歩が2回・分数が後）を指摘できる");
{
  // ⚠ これは**実際にDBに入っていた並び**
  const real = [[
    { f: "印刷用PDF｜a.print" },
    { f: "transportation_id" },
    { f: "分" },                    // ← `required_time` ではなく `分`（実測）
    { f: "transportation_id" },
    { f: "大阪43棟189戸並べ替" },
  ]];
  const r = findWalkResetRisk(real);
  ok("  ⚠ 指摘が出る（旧は null だった）", r !== null, r);
  ok("  種類は walk_reset", r && r.kind === "walk_reset", r && r.kind);
  ok("  ⚠ 理由に「2回以上選んでいる」が入る", r && /2回以上/.test(r.why), r && r.why);
  ok("  次にやる事がある", r && /移動手段 → 分数/.test(r.next), r && r.next);
}

console.log("\n■ ② 正しい順（移動手段 → 分数）なら指摘しない");
{
  const good = [[{ f: "transportation_id" }, { f: "required_time" }]];
  ok("  ⚠ 指摘なし（無駄な指摘を出さない）", findWalkResetRisk(good) === null);
  const good2 = [[{ f: "transportation_id" }, { f: "分" }]];
  ok("  `分` でも正しい順なら指摘なし", findWalkResetRisk(good2) === null);
}

console.log("\n■ ③ 悪い順（分数 → 移動手段）は指摘する");
{
  const bad = [[{ f: "required_time" }, { f: "transportation_id" }]];
  const r = findWalkResetRisk(bad);
  ok("  ⚠ 指摘が出る", r !== null, r);
  ok("  ⚠ 理由に「分数を入れてから」が入る", r && /分数を入れてから/.test(r.why), r && r.why);
}

console.log("\n■ ④ 徒歩が関係ない記録は指摘しない");
{
  ok("  関係ない欄だけ", findWalkResetRisk([[{ f: "rental_cost2" }, { f: "room_layout_id[]" }]]) === null);
  ok("  空", findWalkResetRisk([]) === null);
  ok("  空の回", findWalkResetRisk([[]]) === null);
}

console.log("\n■ ⑤ 本体（learn-flow-steps.ts / human-learn-brain.ts）が同じ決まりを持っている");
{
  ok("  findWalkResetRisk がある", /export function findWalkResetRisk/.test(src));
  ok("  findWeakSteps がある", /export function findWeakSteps/.test(src));
  ok("  ⚠ `分` を分数として扱う", /\^分\$/.test(src));
  ok("  ⚠ 2回選んだら bad が0でも指摘する", /if \(total && bad === 0 && twice === 0\) return null/.test(src));
  ok("  ⚠ 統括の弱い所に足している", /findWeakSteps\(flowsForWalk\)/.test(brain));
  ok("  ⚠ 同じ指摘を2回足さない", /!weak\.some\(\(w\) => w\.kind === s\.kind\)/.test(brain));
  ok("  失敗しても他の弱い所は使う（try/catch）", /徒歩の判定が失敗しても/.test(brain));
}

console.log("\n■ ⑥ 自動で押す側は順番を固定している（消えない）");
{
  const ps = fs.readFileSync(path.join(dir, "chrome-extension", "page-script.js"), "utf8");
  ok("  _keepTransportBeforeWalk がある", /_keepTransportBeforeWalk/.test(ps));
  ok("  並べ替えの後にもそろえる", /_keepTransportBeforeWalk2/.test(ps));
}

console.log("\n■ ⑦ ⚠ 畳む前の並びで判定する（畳むと transportation_id が1回に潰れる）");
{
  /**
   * ⚠ 実測（4つ目の罠）: `sequencesOf` はそのままの並びを返すが、他所では
   *   `collapseSameField`（同じ欄の click→change を畳む）を通す。
   *   畳んだ後だと `transportation_id → transportation_id`（＝選び直しの証拠）が
   *   **1回**に潰れて `walk_reset` が出なくなる（実測で確認）。
   */
  ok("  ⚠ 畳む前の並びで判定すると書いてある", /畳む前の並び\*\*で行う|畳む前の並び/.test(brain));
  ok("  `sequencesOf` をそのまま使っている", /const ops = sequencesOf\(r\);/.test(brain));
  // 畳んだ後の並びでは指摘が出ない事を、写しで確かめる
  const folded = [{ f: "transportation_id" }, { f: "required_time" }, { f: "update_date" }];
  ok("  ⚠ 畳んだ後（徒歩1回）では指摘なし", findWalkResetRisk([folded]) === null);
  const unfolded = [
    { f: "transportation_id" }, { f: "transportation_id" },
    { f: "required_time" }, { f: "required_time" },
  ];
  ok("  ⚠ 畳む前（徒歩2回）では指摘あり", findWalkResetRisk([unfolded]) !== null);
}

console.log("\n■ ⑧ ⚠ `分`（1文字）が学習から捨てられない");
{
  const sl = fs.readFileSync(path.join(dir, "app", "lib", "shot-learn.ts"), "utf8");
  ok("  ⚠ 意味のある1文字は通す（ONE_CHAR_OK）", /ONE_CHAR_OK/.test(sl));
  ok("  ⚠ `分` が入っている", /\[分円階歳畳帖件人駅室棟戸台個日月年\]/.test(sl));
  ok("  数字・記号の1文字は今まで通り捨てる", /n\.length <= 1 && !ONE_CHAR_OK\.test\(n\)/.test(sl));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
