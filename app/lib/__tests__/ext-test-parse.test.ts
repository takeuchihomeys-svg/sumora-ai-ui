// 拡張の試験の出力の読み方（scripts/lib/ext-test-parse.ts）の防衛試験（2.8.314）。
//   実例: 「結果: ✓8 ✗0」の ✗ を失敗と数えて、青い試験が7本ずっと赤扱いだった（本物の赤が山に埋もれた）。
//   実行: npx tsx app/lib/__tests__/ext-test-parse.test.ts
import { countNg, failKeys, failLines, normFail } from "../../../scripts/lib/ext-test-parse";

let pass = 0, fail = 0;
function ok(name: string, c: boolean, extra?: unknown) {
  if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 300))); }
}

// 青い試験が使う件数の書き方（実際にあった形）
const greens = ["結果: ✓8 ✗0", "11 件 ✓ / 0 件 ✗", "  ✓ 項目A\n  ✓ 項目B\n結果: pass=2 fail=0", "21 pass / 0 fail", "74 passed, 0 failed"];
for (const g of greens) {
  ok(`件数の行は失敗に数えない: ${g.split("\n").pop()}`, countNg(g) === 0 && failLines(g).length === 0, { n: countNg(g) });
}

// 赤い試験の失敗の書き方（実際にあった形）
const reds = [
  "  ✓ 項目A\n  ✗ 指定未完了で駅だけ先押し\n      detail\n  ✗ 別の項目\n結果: pass=1 fail=2",
  "NG: ② 客切替の旗（_switchedCust）で使う\n21 pass / 1 fail",
  "❌ 新しい手が増えた\n",
  "FAIL something",
];
ok("✗ 行は数える（2行）", countNg(reds[0]) === 2, countNg(reds[0]));
ok("NG: は失敗の行として拾う（✗ ではないので countNg は 0・failLines は 1）", countNg(reds[1]) === 0 && failLines(reds[1]).length === 1);
ok("❌ は数える", countNg(reds[2]) === 1);
ok("FAIL は失敗の行として拾う", failLines(reds[3]).length === 1);

// 丸め: 版・数字が違っても同じ失敗として比べられる
ok("数字・版・→以降は丸める", normFail("  ✗ 版 2.8.313 が 12 件 → 期待 2.8.314") === normFail("  ✗ 版 2.8.314 が 99 件 → 期待 2.8.999"), normFail("  ✗ 版 2.8.313 が 12 件 → 期待 2.8.314"));
ok("failKeys は重複を1つにする", failKeys("✗ 同じ 1\n✗ 同じ 2\n✗ 別").length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
