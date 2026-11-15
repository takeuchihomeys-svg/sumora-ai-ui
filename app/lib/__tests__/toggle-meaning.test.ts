// app/lib/__tests__/toggle-meaning.test.ts
//
// 2026-11-15 竹内さん「3組目の悠さんは駅での検索なので、前に残っていた
//   泉大津市・西成区・住之江区・浪速区を外すために押している。
//   選択しているのではなくて押すことで前に残っている部分をはずしている」
//   「統括はこのこと理解するために必要な土台作り細部まで理解できるようにする」
//
// なぜ要るか（**私は2回続けて同じ誤読をした**）:
//   記録には「押した欄の名前」しか無く、同じ click が
//   「選んだ」のか「前に残っていたのを外した」のか**区別できなかった**。
//   私は「泉大津市を選んでいる」と読み、実際は「前のお客さんの泉大津市を外していた」。
//   ⚠ 意味が正反対（選んだ＝その条件で検索したい／外した＝その条件はいらない）。
//
// 実行: npx tsx app/lib/__tests__/toggle-meaning.test.ts
import { toggleMeaning, toggleJa, splitToggles, describeToggles, summarizeToggleWork } from "../toggle-meaning";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 「選んだ」と「外した」を区別する");
{
  // 白 → 黒（選んだ）
  ok("was=false → now=true は「選んだ」", toggleMeaning({ was: false, now: true }) === "on");
  // 黒 → 白（外した）← ★ これが悠さんの録画
  ok("was=true → now=false は「外した」", toggleMeaning({ was: true, now: false }) === "off");
  ok("変わらなければ same", toggleMeaning({ was: true, now: true }) === "same");
  ok("false→false も same", toggleMeaning({ was: false, now: false }) === "same");
  ok("押す前が無ければ unknown（推測しない）", toggleMeaning({ f: "泉大津市" }) === "unknown");
  ok("now が無ければ unknown", toggleMeaning({ was: true }) === "unknown");
  ok("null でも落ちない", toggleMeaning(null) === "unknown");
  ok("空でも落ちない", toggleMeaning({}) === "unknown");
}

console.log("\n■ ② 日本語（統括が読む）");
{
  ok("on は「選んだ」", toggleJa("on") === "選んだ");
  ok("off は「前に残っていたのを外した」", toggleJa("off").includes("前に残っていた"));
  ok("unknown は「区別できない」と正直に言う", toggleJa("unknown").includes("区別できない"));
}

console.log("\n■ ③ 悠さんの録画の形（4つ外した・駅を選んだ）");
{
  // 実測: 泉大津市・西成区・住之江区・浪速区を外した（黒→白）
  const ops = [
    { f: "左の泉大津市｜label.one_city", k: "click", was: true, now: false },
    { f: "大阪市西成区｜label.one_city", k: "click", was: true, now: false },
    { f: "大阪市住之江区｜label.one_city", k: "click", was: true, now: false },
    { f: "大阪市浪速区｜label.one_city", k: "click", was: true, now: false },
    // 駅を選んだ（白→黒）
    { f: "左の阪急電鉄宝塚線｜label.one_line", k: "click", was: false, now: true },
    { f: "蛍池｜label.one_station", k: "click", was: false, now: true },
    { f: "豊中｜label.one_station", k: "click", was: false, now: true },
  ];
  const s = splitToggles(ops);
  ok("外した物が4つ", s.off.length === 4, s.off);
  ok("外したのは泉大津市・西成区・住之江区・浪速区", s.off.join(",").includes("泉大津") && s.off.length === 4);
  ok("選んだ物が3つ", s.on.length === 3, s.on);
  ok("選んだのは駅・沿線", s.on.join(",").includes("蛍池") && s.on.join(",").includes("宝塚線"));
  const w = summarizeToggleWork(ops);
  ok("前のお客さんの条件を外す仕事があった", w.hadPrevWork === true);
  ok("外した数が分かる", w.offN === 4);
  ok("選んだ数が分かる", w.onN === 3);
  ok("統括に渡す1行に両方が入る", w.line.includes("外した") && w.line.includes("選んだ"), w.line);
}

console.log("\n■ ④ 旧版の記録（押す前の状態が無い）は正直に言う");
{
  const old = [
    { f: "左の泉大津市｜label.one_city", k: "click" },
    { f: "大阪市西成区｜label.one_city", k: "click" },
  ];
  const s = splitToggles(old);
  ok("外したとは言わない", s.off.length === 0);
  ok("選んだとも言わない", s.on.length === 0);
  ok("区別できないに入る", s.unknown.length === 2);
  const line = describeToggles(old);
  ok("「区別できません」と書く", line.includes("区別できません"), line);
  ok("理由（旧版・押す前の状態が無い）を書く", line.includes("押す前の状態が無い"), line);
}

console.log("\n■ ⑤ 壊れた入力でも落ちない");
{
  ok("空配列", splitToggles([]).off.length === 0);
  ok("null でも落ちない", splitToggles(null as never).on.length === 0);
  ok("null が混ざっても落ちない", splitToggles([null as never, { f: "x", was: false, now: true }]).on.length === 1);
  ok("名前が無い操作は飛ばす", splitToggles([{ was: true, now: false }]).off.length === 0);
  ok("文字列が入っていても落ちない", splitToggles(["x" as never]).off.length === 0);
  ok("describeToggles が空でも落ちない", typeof describeToggles([]) === "string");
  ok("summarizeToggleWork が空でも落ちない", summarizeToggleWork([]).hadPrevWork === false);
}

console.log("\n■ ⑥ なぜ必要かをコードに残している");
{
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../toggle-meaning.ts"), "utf8");
  ok("2回誤読したと書いてある", /2回続けて同じ誤読/.test(src));
  ok("意味が正反対と書いてある", /正反対/.test(src));
  ok("真偽だけ入れると明記", /真偽だけ/.test(src));
  ok("推測で決めないと明記", /推測で on\/off を決めない/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
