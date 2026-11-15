// app/lib/__tests__/supervisor-selfcheck-humanness.test.ts
//
// 2026-11-15 竹内さん「これでちゃんと理解したかな」「弱い部分とうかつはんだんできるようになっているか」
//   「反映させる」
//
// ★ 実測で見つけた2つの問題
//   ① 統括が「人が押す欄を自動モードが押していない 3欄」と言ったが、中身は
//      `AIXLINX｜div`・`#aixlinx-mini-btn`・`左のAIXLINX｜div` ＝ **全部、拡張自身の小窓**だった。
//      → サイトの欄ではないので学ぶ対象ではない（直しても意味が無い）。
//
//   ② 自動モードのカーソル記録 17%・押した位置 12% なのに `verdict: ready`（渡してよい）で
//      **矛盾**していた。自己点検がこの組み合わせを見ていなかった。
//
// 実行: npx tsx app/lib/__tests__/supervisor-selfcheck-humanness.test.ts
import { isOwnPart, filterReallyMissing } from "../auto-mode-improve";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 拡張自身の部品を見分ける");
{
  ok("AIXLINX｜div は拡張の部品", isOwnPart("AIXLINX｜div"));
  ok("#aixlinx-mini-btn は拡張の部品", isOwnPart("#aixlinx-mini-btn"));
  ok("左のAIXLINX｜div も拡張の部品", isOwnPart("左のAIXLINX｜div"));
  ok("axlx-bar も拡張の部品", isOwnPart("axlx-bar"));
  ok("rental_cost2 はサイトの欄（拡張ではない）", !isOwnPart("rental_cost2"));
  ok("大阪市西区｜label.one_city もサイトの欄", !isOwnPart("左の大阪市西区｜label.one_city"));
  ok("空でも落ちない", !isOwnPart(""));
  ok("null でも落ちない", !isOwnPart(null));
}

console.log("\n■ ② 拡張自身の部品を「足りない」から除く");
{
  const r = filterReallyMissing(
    ["AIXLINX｜div", "#aixlinx-mini-btn", "左のAIXLINX｜div", "rental_cost2", "nazo_new"],
    { points: ["rental_cost2"], next: [] },
  );
  ok("拡張の部品は missing に入れない", !r.missing.some((f) => isOwnPart(f)), r.missing);
  ok("束にある欄も missing に入れない", !r.missing.includes("rental_cost2"));
  ok("本当に足りない物だけ残る", r.missing.length === 1 && r.missing[0] === "nazo_new", r.missing);
  ok("束にある物は covered に入る", r.covered.includes("rental_cost2"));
}

console.log("\n■ ③ 自動モードが人間のように動けていないのに「渡してよい」は矛盾");
{
  const adv = superviseLearn({
    rows: 6000, next: 39, points: 80, opens: 13, screens: 2, sequence: 19, with_ops: 3035,
    weak: [], mode_counts: { aix: 289, normal: 1971 }, site_counts: { realpro: 5212 },
    // カーソル 53/311 = 17%・押した位置 37/311 = 12%
    human_like: { ops: 311, typedOnChoose: 0, clickedThenChanged: 7, changedWithoutClick: 0, withCursor: 53, withPoint: 37, rows: 311 },
    // 完走率は高い（93%）＝ 検索は止まっていない状態で確かめる
    audits: { runs: 15, finished: 14, finish_rate: 93, stalled_at: [] },
  } as never);
  ok("verdict は ready になりうる", adv.verdict === "ready" || adv.verdict === "almost", adv.verdict);
  ok("⚠ 自己点検が矛盾を見つける", !adv.self_check.ok, adv.self_check);
  ok("「人間のように動けていない」と名指しする", adv.self_check.issues.some((i) => i.includes("人間のように動けていない") || i.includes("人間のように動けていません")), adv.self_check.issues);
  ok("カーソル 17% を根拠に出す", adv.self_check.issues.some((i) => i.includes("17%")), adv.self_check.issues);
  ok("押した位置 12% を根拠に出す", adv.self_check.issues.some((i) => i.includes("12%")), adv.self_check.issues);
}

console.log("\n■ ④ 人間のように動けていれば矛盾にしない（誤報しない）");
{
  const adv = superviseLearn({
    rows: 6000, next: 39, points: 80, opens: 13, screens: 2, sequence: 19, with_ops: 3035,
    weak: [], mode_counts: { normal: 1971 }, site_counts: { realpro: 5212 },
    // カーソル 96%・押した位置 90%・押さずに変わった0・打ち込み0
    human_like: { ops: 400, typedOnChoose: 0, clickedThenChanged: 10, changedWithoutClick: 0, withCursor: 384, withPoint: 360, rows: 400 },
    audits: { runs: 15, finished: 14, finish_rate: 93, stalled_at: [] },
  } as never);
  ok("✅ 矛盾なし", adv.self_check.ok, adv.self_check.issues);
}

console.log("\n■ ⑤ 押さずに値が変わっていたら矛盾にする");
{
  const adv = superviseLearn({
    rows: 6000, next: 39, points: 80, opens: 13, screens: 2, sequence: 19, with_ops: 3035,
    weak: [], mode_counts: { normal: 1971 }, site_counts: { realpro: 5212 },
    human_like: { ops: 400, typedOnChoose: 0, clickedThenChanged: 5, changedWithoutClick: 4, withCursor: 384, withPoint: 360, rows: 400 },
    audits: { runs: 15, finished: 14, finish_rate: 93, stalled_at: [] },
  } as never);
  ok("⚠ 押さずに値が変わった事で矛盾", !adv.self_check.ok, adv.self_check);
  ok("その理由を名指しする", adv.self_check.issues.some((i) => i.includes("押さずに値が変わった")), adv.self_check.issues);
}

console.log("\n■ ⑥ なぜ必要かをコードに残している");
{
  const fs = require("fs") as typeof import("fs");
  const sup = fs.readFileSync(require("path").join(__dirname, "../learn-supervisor.ts"), "utf8");
  ok("17%・12%で ready になった矛盾を書いてある", /17%/.test(sup) && /12%/.test(sup));
  const ami = fs.readFileSync(require("path").join(__dirname, "../auto-mode-improve.ts"), "utf8");
  ok("拡張自身の部品を除くと書いてある", /拡張自身の部品/.test(ami) && /AIXLINX/.test(ami));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
