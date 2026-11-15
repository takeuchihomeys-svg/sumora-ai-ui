// app/lib/__tests__/shot-gaps.test.ts
//
// 2026-11-15 竹内さん「ここの抜けていた部分もちゃんと統括は把握できるように」「更新は常に許可する」
//
// なぜ要るか（実測）:
//   今日 102枚を読んで欄 3,284個を学んだが、**まだ374枚（大きい写真）が未学習**だった。
//   統括は「何枚読んだか」しか知らされていなかったので「374枚残っている」と言えなかった。
//
// 実行: npx tsx app/lib/__tests__/shot-gaps.test.ts
import { summarizeShotGaps, shotGapTasks } from "../shot-gaps";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 実測の形（102枚読んだ・374枚未学習）");
{
  const rows = [
    // 読めた（大きい・欄あり）102枚
    ...Array.from({ length: 102 }, () => ({ w: 1920, hasKey: true, learned: true, fields: 30 })),
    // 未学習の大きい 374枚
    ...Array.from({ length: 374 }, () => ({ w: 1920, hasKey: true, learned: false })),
    // 小さい未学習 20枚
    ...Array.from({ length: 20 }, () => ({ w: 480, hasKey: true, learned: false })),
  ];
  const g = summarizeShotGaps(rows);
  ok("全部の写真を数える", g.total === 496, g.total);
  ok("学べた枚数", g.learnedOk === 102, g.learnedOk);
  ok("⚠ 未学習の大きい写真を数える", g.unlearnedBig === 374, g.unlearnedBig);
  ok("小さい未学習を数える", g.unlearnedSmall === 20, g.unlearnedSmall);
  ok("読むべき残り", g.todo === 374, g.todo);
  ok("1行に「まだ読める」が出る", g.line.includes("まだ読める"), g.line);
  ok("1行に「小さいので読めない」が出る", g.line.includes("小さいので読めない"), g.line);
}

console.log("\n■ ② 抜けが無い時は「抜けなし」");
{
  const g = summarizeShotGaps(Array.from({ length: 50 }, () => ({ w: 1920, hasKey: true, learned: true, fields: 20 })));
  ok("抜けなし", g.line.includes("抜けなし"), g.line);
  ok("読むべき残りは0", g.todo === 0);
  ok("補強する所も0", shotGapTasks(g).length === 0);
}

console.log("\n■ ③ 読んだのに欄0だった写真");
{
  const g = summarizeShotGaps([
    { w: 1920, hasKey: true, learned: true, fields: 0 },
    { w: 1920, hasKey: true, learned: true, fields: 0 },
    { w: 1920, hasKey: true, learned: true, fields: 30 },
  ]);
  ok("欄0を数える", g.learnedButEmpty === 2, g.learnedButEmpty);
  ok("読むべき残りに入る", g.todo === 2);
  const tasks = shotGapTasks(g);
  ok("「読み方を変える」を出す", tasks.some((t) => t.what.includes("欄が1つも取れなかった")), tasks);
  ok("費用の概算を付ける", tasks.some((t) => t.cost.includes("円")), tasks);
}

console.log("\n■ ④ 小さい写真しか無い時は「撮り直す」");
{
  const g = summarizeShotGaps(Array.from({ length: 10 }, () => ({ w: 480, hasKey: true, learned: false })));
  const tasks = shotGapTasks(g);
  ok("撮り直しを出す", tasks.some((t) => t.next.includes("録画し直す")), tasks);
  ok("費用は0円", tasks.some((t) => t.cost === "0円（録画し直すだけ）"), tasks);
}

console.log("\n■ ⑤ 費用の見積り（1枚0.17円）");
{
  const g = summarizeShotGaps(Array.from({ length: 100 }, () => ({ w: 1920, hasKey: true, learned: false })));
  const tasks = shotGapTasks(g);
  ok("100枚なら約17円", tasks.some((t) => t.cost.includes("17円")), tasks);
}

console.log("\n■ ⑥ 壊れた入力でも落ちない");
{
  ok("空配列", summarizeShotGaps([]).total === 0);
  ok("null でも落ちない", summarizeShotGaps(null as never).total === 0);
  ok("null が混ざっても落ちない", summarizeShotGaps([null as never, { w: 1920, hasKey: true, learned: false }]).total === 1);
  ok("写真が無い行は数えない", summarizeShotGaps([{ w: 1920, hasKey: false, learned: false }]).total === 0);
  ok("長さが無くても落ちない", summarizeShotGaps([{ w: 0, hasKey: true, learned: false }]).unlearnedSmall === 1);
  ok("shotGapTasks が空でも落ちない", shotGapTasks(summarizeShotGaps([])).length === 0);
}

console.log("\n■ ⑦ なぜ必要かをコードに残している");
{
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../shot-gaps.ts"), "utf8");
  ok("374枚の実測を残している", /374/.test(src));
  ok("統括が言えなかったと書いてある", /言えなかった/.test(src));
  ok("1枚0.17円を残している", /0\.17/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
