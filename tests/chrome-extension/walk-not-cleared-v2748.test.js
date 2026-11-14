// tests/chrome-extension/walk-not-cleared-v2748.test.js
// 実行: node tests/chrome-extension/walk-not-cleared-v2748.test.js
// 2026-11-14 竹内さん「まだ徒歩の部分一度選択した後に消えるようになってしまっている」
//
//   原因: 条件の**入力順を学んだ順に並べ替える**処理（`_orderByLearned`）が、
//         「移動手段（transportation_id）」と「分数（required_time）」の順番も入れ替えていた。
//
//   ⚠ リアプロは移動手段を選ぶと**その下の分数がリセットされる**（画面が作り直される）。
//     人がやっても同じ。だから
//       ① 分数を打つ（10） → ② 移動手段を選ぶ → **分数が消える**
//     という順になると「一度選んだ後に消える」。
//     実測で「入る時と入らない時がある」＝学んだ順によって変わっていた。
//
//   直し: **移動手段は必ず分数より先**に固定（学んだ順でも入れ替えない）。
//         ⚠ これは見た目の好みではなく**画面の仕組み**なので、学習より優先する。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ps = read("page-script.js");
const code = ps.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① 移動手段を分数より前に固定している（並べ替えの前後で2回）");
{
  const guards = code.match(/_keepTransportBeforeWalk2?/g) || [];
  ok("並べ替えの前にそろえる", /_keepTransportBeforeWalk\(\)/.test(code));
  ok("並べ替えの後にもそろえる（鎖で戻されても直す）", /_keepTransportBeforeWalk2\(\)/.test(code));
  ok("  2か所ある", guards.length >= 2, guards.length);
  // 並べ替え（_orderByLearned の適用）より後に2回目がある
  const iOrder = code.indexOf("_basicQueue = _orderByLearned(_basicQueue)");
  const iGuard2 = code.indexOf("_keepTransportBeforeWalk2()");
  ok("  ⚠ 2回目は _orderByLearned の**後**", iOrder > 0 && iGuard2 > iOrder, { iOrder, iGuard2 });
  // 1回目は前
  const iGuard1 = code.indexOf("_keepTransportBeforeWalk()");
  ok("  1回目は _orderByLearned の**前**", iGuard1 > 0 && iGuard1 < iOrder, { iGuard1, iOrder });
}

console.log("\n■ ② 分数は移動手段を選んだ「後」に打つ");
{
  const iTrans = code.indexOf('name: "transportation_id"');
  const iWalk = code.indexOf('name: "required_time"');
  ok("transportation_id を積む所がある", iTrans > 0);
  ok("required_time を積む所がある", iWalk > 0);
  ok("  積む順が 移動手段 → 分数", iTrans < iWalk, { iTrans, iWalk });
}

console.log("\n■ ③ 実際に並べ替えても順番が守られる（learn-order をそのまま使って確かめる）");
{
  const LO = require(path.join(dir, "learn-order.js"));
  // 人が「分数 → 移動手段」の順で押した記録（＝消える順）を学んだ場合を作る
  const names = ["transportation_id", "required_time", "rental_cost2"];
  const learned = LO.mergeWithSequence(null, ["required_time", "transportation_id", "rental_cost2"], names);
  ok("学んだ鎖が分数→移動手段を作る（これが原因）", !!learned.required_time, learned);

  // page-script と同じ形のキューを作り、同じ手順（前そろえ→並べ替え→後そろえ）を通す
  const queue = [
    { name: "transportation_id" },
    { name: "required_time" },
    { name: "rental_cost2" },
  ];
  const fix = (q) => {
    let ti = -1, wi = -1;
    for (let i = 0; i < q.length; i++) {
      if (q[i].name === "transportation_id") ti = i;
      else if (q[i].name === "required_time") wi = i;
    }
    if (ti < 0 || wi < 0 || ti < wi) return q;
    const tr = q.splice(ti, 1)[0];
    wi = q.findIndex((x) => x.name === "required_time");
    q.splice(wi, 0, tr);
    return q;
  };
  const ordered = LO.orderByLearned(queue, (it) => it.name, learned, { min: 2 }).items;
  const final = fix(ordered);
  const order = final.map((x) => x.name);
  ok("最終的に 移動手段 が 分数 より前", order.indexOf("transportation_id") < order.indexOf("required_time"), order);
  ok("  件数は変わらない（条件を落とさない）", final.length === 3, order);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
