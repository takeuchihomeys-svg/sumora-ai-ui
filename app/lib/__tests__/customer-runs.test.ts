// app/lib/__tests__/customer-runs.test.ts
//
// 2026-11-15 竹内さん「まりあ　ゆーと　悠の順番で」「前に残っていたのを外している部分もちゃんと理解して学習する」
//   「ここの記憶の部分は自動検索でお客さんを連続で検索するにあたってかなり重要になる」
//
// なぜ要るか:
//   ⚠ `human_motion_learn` に**お客様IDの列が無い**ので、3人の操作が1本に混ざる。
//     私はこれで2回誤読した（「泉大津市を選んでいる」→実際は前のお客さんのを外していた）。
//   → **検索を押した所で区切る**と1つの検索＝1人のお客さんになる（実測: 今日は3組に分かれた）。
//
// 実行: npx tsx app/lib/__tests__/customer-runs.test.ts
import { splitByCustomer, summarizeRun, isSearchPress, areaKindOf, KIND_JA, type RunRow } from "../customer-runs";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 検索を押したか（お客さんの切れ目）");
{
  ok("左の検索｜span の click は検索", isSearchPress({ k: "click", f: "左の検索｜span" }));
  /**
   * ⚠ 2026-11-15 実測: 「住居検索」を切れ目にすると**4組に分かれた**（本当は3組）。
   *   住居検索は**検索の画面へ移る**ボタンで、条件を入れて押す「検索」ではない。
   */
  ok("住居検索は切れ目にしない（画面移動）", !isSearchPress({ k: "click", f: "左の住居検索｜a.text" }));
  ok("検索の change は違う（押していない）", !isSearchPress({ k: "change", f: "左の検索｜span" }));
  ok("確定してリストへは検索ではない", !isSearchPress({ k: "click", f: "確定してリストへ｜span" }));
  ok("空でも落ちない", !isSearchPress(null) && !isSearchPress({}));
}

console.log("\n■ ①-b 細分化（種類を決める）");
{
  ok("label.one_city は区・市", areaKindOf("左の大阪市西区｜label.one_city") === "city");
  ok("city_code[] も区・市", areaKindOf("city_code[]") === "city");
  ok("label.one_town は町字", areaKindOf("左の〇〇町｜label.one_town") === "town");
  ok("label.one_line は沿線", areaKindOf("左の阪急電鉄宝塚線｜label.one_line") === "line");
  ok("label.one_station は駅", areaKindOf("蛍池｜label.one_station") === "station");
  ok("room_layout_id[] は間取り", areaKindOf("room_layout_id[]") === "layout");
  ok("rental_cost2 は条件", areaKindOf("rental_cost2") === "cond");
  ok("required_time も条件", areaKindOf("required_time") === "cond");
  ok("deposit_recommpence も条件", areaKindOf("deposit_recommpence") === "cond");
  ok("知らない物は other", areaKindOf("なにか") === "other");
  ok("空でも落ちない", areaKindOf(null) === "other");
  ok("日本語がある", KIND_JA.city === "区・市" && KIND_JA.station === "駅");
}

// 実測の形（3組・時刻は実際の物を縮めた値）
const T = 1794735000000;
const rows: RunRow[] = [
  // 1組目（まりあ）: 西区・中央区・北区 → 検索
  { created_at: new Date(T + 1000).toISOString(), shot_ops: [
    { t: T + 1000, k: "click", f: "左の大阪市西区｜label.one_city", was: false, now: true },
    { t: T + 2000, k: "click", f: "左の大阪市中央区｜label.one_city", was: false, now: true },
    { t: T + 3000, k: "click", f: "左の大阪市北区｜label.one_city", was: false, now: true },
    { t: T + 4000, k: "click", f: "左の検索｜span" },
  ] },
  // 2組目（ゆーと）: 前の3区を外して + 西成区・浪速区・住之江区・泉大津市 → 検索
  { created_at: new Date(T + 20000).toISOString(), shot_ops: [
    { t: T + 11000, k: "click", f: "左の大阪市西区｜label.one_city", was: true, now: false },
    { t: T + 12000, k: "click", f: "大阪市西成区｜label.one_city", was: false, now: true },
    { t: T + 13000, k: "click", f: "大阪市浪速区｜label.one_city", was: false, now: true },
    { t: T + 14000, k: "click", f: "左の泉大津市｜label.one_city", was: false, now: true },
    { t: T + 20000, k: "click", f: "左の検索｜span" },
  ] },
  // 3組目（悠）: 駅を選ぶ + 前の地域を外す → 検索
  { created_at: new Date(T + 40000).toISOString(), shot_ops: [
    { t: T + 31000, k: "click", f: "左の阪急電鉄宝塚線｜label.one_line", was: false, now: true },
    { t: T + 32000, k: "click", f: "蛍池｜label.one_station", was: false, now: true },
    { t: T + 33000, k: "click", f: "左の泉大津市｜label.one_city", was: true, now: false },
    { t: T + 34000, k: "click", f: "大阪市西成区｜label.one_city", was: true, now: false },
    { t: T + 40000, k: "click", f: "左の検索｜span" },
  ] },
];

console.log("\n■ ② 3組に分かれる（検索を押した所で区切る）");
{
  const runs = splitByCustomer(rows);
  ok("3組に分かれる", runs.length === 3, runs.length);
  ok("1組目から順番（古い順）", runs[0].index === 1 && runs[2].index === 3);
  ok("1組目の操作は4手", runs[0].ops.length === 4, runs[0].ops.length);
  ok("1組目は検索で終わる", isSearchPress(runs[0].ops[runs[0].ops.length - 1]));
  ok("検索した時刻が残る", typeof runs[0].searchedAt === "number");
}

console.log("\n■ ③ 各組の中身（外した・選んだ・種類）");
{
  const runs = splitByCustomer(rows);
  const s1 = summarizeRun(runs[0]);
  ok("1組目（まりあ）: 3つ選んだ", s1.onN === 3, s1);
  ok("1組目: 外したのは0", s1.offN === 0);
  ok("1組目: 場所の種類は区・市", s1.areaKinds.includes("区・市"), s1.areaKinds);

  const s2 = summarizeRun(runs[1]);
  ok("2組目（ゆーと）: 前に残っていたのを外した1件", s2.offN === 1, s2.offN);
  ok("2組目: 選んだのは3件", s2.onN === 3, s2.onN);
  ok("2組目: 外したのは西区", s2.offNames.join(",").includes("西区"), s2.offNames);

  const s3 = summarizeRun(runs[2]);
  ok("3組目（悠）: 前に残っていたのを外した2件", s3.offN === 2, s3.offN);
  ok("3組目: 選んだのは2件（沿線・駅）", s3.onN === 2, s3.onN);
  ok("3組目: 場所の種類に沿線と駅が入る", s3.areaKinds.includes("沿線") && s3.areaKinds.includes("駅"), s3.areaKinds);
  ok("3組目の1行に「外した」が入る", s3.line.includes("外した"), s3.line);
  /**
   * ★ 2026-11-15「ここの部分追加する」= **細分化**。
   *   統括が「区は外せたが沿線が残っている」のように**種類ごと**に言える。
   */
  ok("3組目: 外したのは区・市が2件", s3.offByKind.city === 2, s3.offByKind);
  ok("3組目: 選んだのは沿線1件・駅1件", s3.onByKind.line === 1 && s3.onByKind.station === 1, s3.onByKind);
  ok("3組目の細分化した行に「区・市 を外した 2件」が入る", s3.kindLine.includes("区・市 を外した 2件"), s3.kindLine);
  ok("3組目の細分化した行に「駅 を選んだ 1件」が入る", s3.kindLine.includes("駅 を選んだ 1件"), s3.kindLine);
}

console.log("\n■ ④ 旧版の記録（押す前の状態が無い）は正直に言う");
{
  const old: RunRow[] = [{ created_at: new Date(T).toISOString(), shot_ops: [
    { t: T + 1000, k: "click", f: "左の泉大津市｜label.one_city" },
    { t: T + 2000, k: "click", f: "左の検索｜span" },
  ] }];
  const s = summarizeRun(splitByCustomer(old)[0]);
  ok("外したとは言わない", s.offN === 0);
  ok("選んだとも言わない", s.onN === 0);
  ok("区別できないと書く", s.line.includes("区別できない"), s.line);
}

console.log("\n■ ⑤ 検索が1回も無い時・壊れた入力");
{
  const one: RunRow[] = [{ created_at: new Date(T).toISOString(), shot_ops: [
    { t: T + 1000, k: "click", f: "左の大阪市西区｜label.one_city", was: false, now: true },
  ] }];
  const runs = splitByCustomer(one);
  ok("検索が無ければ1組", runs.length === 1);
  ok("検索した時刻は null", runs[0].searchedAt === null);
  ok("空配列", splitByCustomer([]).length === 0);
  ok("null でも落ちない", splitByCustomer(null as never).length === 0);
  ok("null が混ざっても落ちない", splitByCustomer([null as never, one[0]]).length >= 1);
  ok("shot_ops が無くても落ちない", splitByCustomer([{ created_at: new Date(T).toISOString() }]).length >= 1);
}

console.log("\n■ ⑥ 名前を推測で付けない（正直さ）");
{
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../customer-runs.ts"), "utf8");
  ok("お客様IDの列が無いと書いてある", /お客様IDの列が無い/.test(src));
  ok("名前は分からないと書いてある", /名前は記録からは分からない|名前を\*\*推測で付けない\*\*/.test(src));
  ok("2回誤読したと書いてある", /2回誤読/.test(src));
  ok("列を増やさずに分けると書いてある", /列を増やさずに/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
