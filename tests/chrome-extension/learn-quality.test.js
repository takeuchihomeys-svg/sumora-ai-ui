// 「自動検索のところちゃんと学習されるか」の試験（2026-11-13）
//
// 竹内さん「改善はちゃんとされてるかな／自動検索のところちゃんと学習されるようになっているのか／
//   データベース改善されてるのかな」
//
// 実測で見つけた3つの穴:
//   ① 点検の並びに「A B A B…」の交互クリックが入っていた（40件中24件）
//      原因: チェックは label を押すと input にも click が伝わり、**同じ1回が2回記録**される
//      （`左の1K｜label` と `room_layout_id[]` が交互）
//      → 学習すると人がやらない押し方を学び、確からしさが 20/20回（100%）になっていた
//   ② 地域の区を「DOM上はchecked だがボタンN」で**押し直して外していた**（トグル）
//   ③ 学習の材料が **3000行で打ち切り**（実測 3179行あり、古い記録が枠を食っていた）
//
// 実行: node tests/chrome-extension/learn-quality.test.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 同じチェックを1回に畳む（交互クリックの原因）");
{
  const r = read("human-learn-record.js");
  t("label と input の対を検出する", /isPair/.test(r));
  t("チェック系（name に []）だけ", /indexOf\("\[\]"\) < 0/.test(r));
  t("近い時（400ms以内）だけ畳む", /gap2 <= 400/.test(r));
  t("同じ親の中かを確かめる", /closest\("label"\) === lab/.test(r));
  t("DOM 要素を送らない", /return \{ t: o\.t, k: o\.k, f: o\.f, w: o\.w, g: o\.g \}/.test(r));
}

console.log("■ ② 区を押し直して外さない（トグル）");
{
  const ps = read("page-script.js");
  const seg = ps.slice(ps.indexOf("if (inp && inp.checked && isWardButtonY())"));
  t("checked の時に simulateClick で押し直さない", !/if \(inp && inp\.checked\) \{\s*\n\s*simulateClick\(wardLabels\[i\]\)/.test(ps));
  t("代わりに ensureWardButtonY で状態を整える", /ensureWardButtonY\(function \(\) \{\}\)/.test(ps));
  t("区を押した事は記録する", seg.includes("_noteWardPicked"));
}

console.log("■ ③ 学習の材料を3000行で打ち切らない");
{
  const route = fs.readFileSync(path.join(ROOT, "app", "api", "human-learn-profile", "route.ts"), "utf8");
  t("上限が6000になった", /MAX_ROWS = 6000/.test(route));
  t("3000の直書きが無い", !/i < 3000; i \+= 1000/.test(route));
  t("新しい順に読む（打ち切られても古い方が落ちる）", /order\("created_at", \{ ascending: false \}\)/.test(route));
}

console.log("■ ④ 交互クリック（トグル跡）を学習に使わない");
{
  // human-learn-brain.ts の looksLikeToggleLoop を、JS に直して同じ判定を試す
  const brain = fs.readFileSync(path.join(ROOT, "app", "lib", "human-learn-brain.ts"), "utf8");
  t("looksLikeToggleLoop がある", brain.includes("export function looksLikeToggleLoop"));
  t("next の材料から外す", /if \(looksLikeToggleLoop\(s\)\) continue;/.test(brain));
  t("site_flow からも外す", /looksLikeToggleLoop\(s\)\) continue;[\s\S]{0,400}flowSeen/.test(brain));

  // 判定を JS で再現して確かめる
  const isToggle = (seq) => {
    if (!Array.isArray(seq) || seq.length < 6) return false;
    const f = seq.map((x) => String(x?.f ?? ""));
    let alt = 0;
    for (let i = 2; i < f.length; i++) {
      if (f[i] && f[i] === f[i - 2] && f[i] !== f[i - 1]) alt++;
      else alt = 0;
      if (alt >= 4) return true;
    }
    let run = 1;
    for (let i = 1; i < f.length; i++) {
      if (f[i] && f[i] === f[i - 1]) { run++; if (run >= 4) return true; }
      else run = 1;
    }
    return false;
  };
  // 実測で出ていた形（1K ⇄ 間取り が10回）
  const real = [];
  for (let i = 0; i < 5; i++) real.push({ f: "左の1K｜label" }, { f: "room_layout_id[]" });
  t("実物の交互（1K ⇄ 間取り 10回）を検出する", isToggle(real) === true);
  // 人の普通の順
  const human = ["確定してリストへ｜span", "required_time", "rental_cost2", "square_meter_l", "rental_cost1", "structured_date"].map((f) => ({ f }));
  t("人の普通の順は通す", isToggle(human) === false);
  // 同じ欄の連打（4回以上）
  t("同じ欄を4回連続も除外する", isToggle([{ f: "a" }, { f: "a" }, { f: "a" }, { f: "a" }, { f: "b" }, { f: "c" }]) === true);
}

console.log("■ ⑤ 賃料の順は「上限が先」が人の実測（誤って直さない）");
{
  // 実測: 41回中41回、rental_cost2（上限）が先
  const next = {
    rental_cost2: { next: "左の敷金・礼金なし｜label", n: 11, total: 11 },
    square_meter_l: { next: "rental_cost1", n: 8, total: 12 },
  };
  const LO = require(path.join(SRC, "learn-order.js"));
  const merged = LO.mergeLearnedOrder(next, {}, { names: ["rental_cost1", "rental_cost2", "square_meter_l"] });
  t("学んだ組をそのまま使う（勝手に並べ直さない）", merged.square_meter_l.next === "rental_cost1", merged);
  const r = LO.orderByLearned([{ name: "rental_cost1" }, { name: "rental_cost2" }, { name: "square_meter_l" }], (x) => x.name, merged, { min: 2, wobble: 0 });
  t("項目は増減しない", r.items.length === 3);
  t("学んだ関係（面積→賃料下限）が守られる", r.items.map((x) => x.name).indexOf("square_meter_l") < r.items.map((x) => x.name).indexOf("rental_cost1"), r.items.map((x) => x.name));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
