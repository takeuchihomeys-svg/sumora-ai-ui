// 通常モードで学んだ順番が「自動モード」でも効くか（2026-11-14）
//
// 竹内さん「普通モードで画面録画していた動きを自動モード改善されたのか」
//
// 確認する事:
//   ① 自動モード（aixlinx-fill）も通常モードと同じ fillRealpro を通る
//   ② _orderByLearned にモードの分岐が無い（全モードで同じ学習が効く）
//   ③ ただし案内モード（data-axlx-guide !== "0"）は入力しない＝学習を使う前に止まる
//   ④ 自動モードの判定（autoModeAt > 0 かつ aixMode/aiMode）
//
// 実行: node tests/chrome-extension/learn-applies-to-auto.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 自動モードも同じ入力関数（fillRealpro）を通る");
{
  const ps = read("page-script.js");
  t("aixlinx-fill を受ける", /e\.data\.from !== "aixlinx-fill"/.test(ps));
  // 2.8.313: 受けた後の関所（別客の入力中は断る等）が増えて窓 {0,1800} では届かない。受け口の始まりから fillRealpro の呼びまで、別の message 受け口をまたがずに続く事を見る。
  {
    const i = ps.indexOf('e.data.from !== "aixlinx-fill") return;');
    const j = ps.indexOf("fillRealpro(e.data.conditions)", i);
    const between = i > 0 && j > i ? ps.slice(i + 10, j) : "";
    t("その中で fillRealpro を呼ぶ", i > 0 && j > i && j - i < 15000 && !/addEventListener\("message"/.test(between), { i, j });
  }
}

console.log("■ ② 学習の並べ替えにモードの分岐が無い（全モード共通）");
{
  const ps = read("page-script.js");
  t("_orderByLearned は1か所で定義", (ps.match(/function _orderByLearned\(/g) || []).length === 1);
  t("_orderByLearned の中にモード判定が無い",
    !/function _orderByLearned\([\s\S]{0,1200}(aixMode|aiMode|staffMode|autoModeAt)/.test(ps));
  t("fillRealpro の中で呼ばれる", /_basicQueue = _orderByLearned\(_basicQueue\)/.test(ps));
  t("呼ぶ所は1か所（まとめて並べ替え）", (ps.match(/_basicQueue = _orderByLearned\(_basicQueue\);/g) || []).length === 1);
}

console.log("■ ③ 案内モードの時は入力しない（学習を使う前に止まる）");
{
  const ps = read("page-script.js");
  t("案内モードの判定がある", /getAttribute\("data-axlx-guide"\) !== "0"/.test(ps));
  t("案内モードなら fillRealpro を呼ばずに return", /data-axlx-guide"\) !== "0"\) \{[\s\S]{0,600}notifyDone\("guide-mode[\s\S]{0,200}return;/.test(ps));
}

console.log("■ ④ 自動モードの判定（案内をOFFにする条件）");
{
  const g = read("realpro-guide.js");
  t("autoModeOf がある", /function autoModeOf\(/.test(g));
  // 2.8.313 退役: 「スタッフは自動にしない」— 2026-11-22 にスタッフも選んだ客の自動検索〜送付のため案内 OFF（AIX相当）へ設計を変えた
  //   （realpro-guide.js autoModeOf のコメント「スタッフも選んだ客の自動検索〜送付のため案内 OFF」・bulk-dl.js _readAutoMode・memory/dept_search_tool.md「スタッフモードでお客さんを選ぶ→…送付まで」）。
  //   置き換え: スタッフ（2時間の期限内）は自動側（true）になる事を見る。
  t("スタッフ（選んだ客）も自動にする（2時間の期限つき）", /var staffOn = !!s\.staffMode && \(!at \|\| Date\.now\(\) - at <= 2 \* 60 \* 60 \* 1000\);[\s\S]{0,600}if \(staffOn\) return true;/.test(g));
  t("autoModeAt が要る", /Number\(s\.autoModeAt\) > 0/.test(g));
  t("aixMode か aiMode が要る", /chosen && \(!!s\.aixMode \|\| !!s\.aiMode\)/.test(g));
  t("自動の時は案内をOFFにする", /guideOn = !\(v === true\)/.test(g));
}

console.log("■ ⑤ 学習の束は「モードに関係なく」拡張へ届く");
{
  const bg = read("background.js");
  t("1日1回 _refreshLearnedBundle で取る", /_refreshLearnedBundle/.test(bg));
  t("storage に axlx_learn_next を置く", /axlx_learn_next: next/.test(bg));
  t("モードで分岐していない（取り込みにモード条件が無い）",
    !/function _refreshLearnedBundle[\s\S]{0,1500}(aixMode|staffMode|autoModeAt)/.test(bg));
  const ps = read("page-script.js");
  t("page-script が axlx_learn_next を読む", /axlx_learn_next/.test(ps));
}

console.log("■ ⑥ 実際に並べ替えが効く（純関数で確認・モード非依存）");
{
  const LO = require(path.join(SRC, "learn-order.js"));
  // 通常モードで学んだ順（賃料上限 → 面積 → 賃料下限）
  const next = {
    rental_cost2: { next: "square_meter_l", n: 6, total: 6 },
    square_meter_l: { next: "rental_cost1", n: 6, total: 6 },
  };
  const items = [{ name: "rental_cost1" }, { name: "rental_cost2" }, { name: "square_meter_l" }];
  const r = LO.orderByLearned(items, (x) => x && x.name, next, { min: 2, wobble: 0 });
  t("学んだ順になる（自動モードでも同じ関数）", r.items.map((x) => x.name).join(">") === "rental_cost2>square_meter_l>rental_cost1", r.items.map((x) => x.name));
  t("項目は増減しない", r.items.length === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
