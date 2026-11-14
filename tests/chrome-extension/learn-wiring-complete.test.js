// 「一連の動きの学習・強化・反映」で抜けていた所（2026-11-14）
//
// 竹内さん「ほかにも抜けていて強化する部分あれば強化する。
//   一連の動くの学習や強化、反映の為に抜けている部分がある可能性もある。その点含めて強化する」
//
// 実測で見つけた抜け:
//   ① サーバーが作った by_mode / mode_plan / sequence_flow / learn_plan を
//      拡張が**1つも読んでいなかった**（0箇所）＝ 計算しても現場に届かない
//   ② point_fields に**押した順番が無かった**（時刻も順番も無い）ので、
//      写真が少ない通常モードでは順番を学べなかった（実測 normal 34件で順番0）
//   ③ field_order（押した順番）と fields を**読む列に入れていなかった**
//   ④ sequencesOf が shot_ops しか見ていなかった（field_order を使っていない）
//   ⑤ 一連の動きの型（鎖）を**並べ替えに使っていなかった**
//
// 実行: node tests/chrome-extension/learn-wiring-complete.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

const bg = read("background.js");
const ps = read("page-script.js");
const hl = read("human-learn.js");
const rec = read("human-learn-record.js");
const lo = read("learn-order.js");

console.log("■ ① サーバーの学びが現場に届く（実測0箇所だった物）");
{
  t("axlx_learn_seq（一連の動き）を置く", bg.includes("axlx_learn_seq"));
  t("axlx_learn_by_mode（モード別）を置く", bg.includes("axlx_learn_by_mode"));
  t("axlx_learn_plan（統括の判断）を置く", bg.includes("axlx_learn_plan"));
  t("モード別の押す順番を置く", bg.includes("axlx_learn_next_mode"));
  t("今のモードを読んで選ぶ", /var myMode = await _modeLabelNow\(\)/.test(bg));
  t("page-script が一連の動きを読む", ps.includes("axlx_learn_seq"));
  t("page-script がモード別を読む", ps.includes("axlx_learn_next_mode"));
}

console.log("■ ② 押した順番を記録する（写真が無くても）");
{
  t("recordPoint に通し番号 n を入れる", /n: points\.length \+ 1,/.test(hl));
  t("要点の集計に order（初めて押した順）を持つ", /var order = \[\];/.test(hl));
  t("重複を畳んで順番を作る", /if \(order\.indexOf\(f\) < 0\) order\.push\(f\);/.test(hl));
  t("points の戻り値に order", /order: order\.slice\(0, 40\)/.test(hl));
  t("記録が order を送る", /add\.order = \(motion\.points && motion\.points\.order\)/.test(rec));
  t("記録が fields も送る", /add\.fields = Object\.keys/.test(rec));
}

console.log("■ ③ サーバーが field_order を読む");
{
  const brain = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "human-learn-brain.ts"), "utf8");
  t("sequencesOf が field_order を見る", /const fo = row\.field_order;/.test(brain));
  t("shot_ops を優先する", /if \(seq\.length >= 2\) return \[seq\];[\s\S]{0,600}const fo = row\.field_order/.test(brain));
  const prof = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-learn-profile", "route.ts"), "utf8");
  t("profile の SELECT に field_order", prof.includes('"field_order"'));
  t("profile の SELECT に fields", prof.includes('"fields"'));
}

console.log("■ ④ 一連の動きの型を並べ替えに使う");
{
  t("鎖から前後関係を作る関数", lo.includes("function beforePairsFromSequence"));
  t("鎖と next を合わせる関数", lo.includes("function mergeWithSequence"));
  t("next を優先する（鎖で上書きしない）", /Object\.keys\(base\)\.forEach\(function \(k\) \{ out\[k\] = base\[k\]; \}\)/.test(lo));
  t("export している", lo.includes("beforePairsFromSequence: beforePairsFromSequence") && lo.includes("mergeWithSequence: mergeWithSequence"));
  t("page-script が鎖を使う", /LO\.mergeWithSequence\(next, seq\.sequence, names\)/.test(ps));
  t("モード別を先に重ねる", /next = Object\.assign\(\{\}, modeNext, next \|\| \{\}\)/.test(ps));
}

console.log("■ ⑤ 鎖は「集合の中だけ」の組を作る（検索漏れを出さない）");
{
  // learn-order.js を実際に動かして確かめる
  delete require.cache[require.resolve(path.join(SRC, "learn-order.js"))];
  const LO = require(path.join(SRC, "learn-order.js"));
  const seq = ["所在地絞り込み", "区を選ぶ", "確定してリストへ", "required_time", "rental_cost2", "square_meter_l", "rental_cost1", "左の検索｜span"];
  const names = ["rental_cost1", "rental_cost2", "square_meter_l"];
  const pairs = LO.beforePairsFromSequence(seq, names);
  t("集合内の前後関係だけ作る", Object.keys(pairs).every((k) => names.includes(k)), Object.keys(pairs));
  t("rental_cost2 は square_meter_l より前", pairs.rental_cost2 && pairs.rental_cost2.next === "square_meter_l", pairs.rental_cost2);
  t("rental_cost2 は rental_cost1 より前", pairs.square_meter_l && pairs.square_meter_l.next === "rental_cost1", pairs.square_meter_l);
  t("集合に無い名前は入らない", !pairs["所在地絞り込み"] && !pairs["確定してリストへ"], Object.keys(pairs));

  const merged = LO.mergeWithSequence({ rental_cost1: { next: "rental_cost2", n: 9, total: 9 } }, seq, names);
  t("next を鎖で上書きしない", merged.rental_cost1.next === "rental_cost2" && merged.rental_cost1.n === 9, merged.rental_cost1);
  t("鎖で足りない所を補う", !!merged.rental_cost2, Object.keys(merged));
}

console.log("■ ⑥ 実際に並べ替えが効く（鎖だけでも）");
{
  const LO = require(path.join(SRC, "learn-order.js"));
  // next が空でも、鎖だけで順番が決まる
  const seq = ["required_time", "rental_cost2", "square_meter_l", "rental_cost1"];
  const names = ["rental_cost1", "rental_cost2", "square_meter_l"];
  const merged = LO.mergeWithSequence({}, seq, names);
  const items = names.map((n) => ({ name: n }));
  const r = LO.orderByLearned(items, (x) => x.name, merged, { min: 2, wobble: 0 });
  t("鎖だけで学んだ順になる", r.items.map((x) => x.name).join(">") === "rental_cost2>square_meter_l>rental_cost1", r.items.map((x) => x.name));
  t("項目は増減しない", r.items.length === names.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
