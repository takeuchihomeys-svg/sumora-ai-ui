// app/lib/__tests__/repeat-learn.test.ts
//
// 2026-11-15 竹内さん「通常モードの録画でもちゃんと学習できるように 足りない部分強化できるように
//   通常モードと自動モード繰りかえしていくようにして学習する
//   そして学習の質も上げれるように設計知見強化する」
//
// ★ なぜ「繰り返す」のか（実測）
//   通常モード: 操作の並び97%・カーソル94%・押した位置74%
//   自動モード: 操作の並び96%・カーソル75%・押した位置 **7%**（通常の1/10）
//   was（選んだ/外した）: 両方 0%（送る所で捨てていた・v2.7.81で修正）
//   → 1回直して終わりにしない。直したら**また録画して数字を見る**。
//
// 実行: npx tsx app/lib/__tests__/repeat-learn.test.ts
import { compareModes, repeatTasks, learnQuality } from "../repeat-learn";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

const normal = { rows: 800, withOps: 777, withCursor: 753, withPoint: 593, withLearn: 224, withWas: 0 };
const auto = { rows: 297, withOps: 285, withCursor: 223, withPoint: 20, withLearn: 64, withWas: 0 };

console.log("■ ① 通常と自動を比べる（実測の形）");
{
  const r = compareModes(normal, auto);
  ok("通常の操作の並び 97%", r.normal.pct.ops === 97, r.normal.pct);
  ok("通常のカーソル 94%", r.normal.pct.cursor === 94);
  ok("通常の押した位置 74%", r.normal.pct.point === 74);
  ok("自動の押した位置 7%", r.auto.pct.point === 7, r.auto.pct);
  ok("1行で分かる", r.line.includes("通常") && r.line.includes("自動"), r.line);
}

console.log("\n■ ② 自動モードが大きく劣る所を差の大きい順に出す");
{
  const r = compareModes(normal, auto);
  /**
   * ⚠ 実測に基づく期待値:
   *   押した位置 74% → 7% = **差67**（出る）
   *   カーソル   94% → 75% = **差19**（30未満なので出さない・誤報しない）
   *   操作の並び 97% → 96% = 差1（出さない）
   *   → 「大きく劣る所」は**押した位置だけ**が正しい。
   */
  ok("劣る所が出る（押した位置）", r.weak.length === 1, r.weak);
  ok("一番は「押した位置」（差67）", r.weak[0].key === "point" && r.weak[0].gap === 67, r.weak[0]);
  ok("⚠ 差19のカーソルは出さない（30未満）", !r.weak.some((w) => w.key === "cursor"), r.weak);
  ok("差1の操作の並びも出さない", !r.weak.some((w) => w.key === "ops"), r.weak);
  // カーソルの差が大きい時は出る
  const bigGap = compareModes(normal, { ...auto, withCursor: 60 });
  ok("カーソルの差が大きければ出す", bigGap.weak.some((w) => w.key === "cursor"), bigGap.weak);
}

console.log("\n■ ③ 次にやる事（費用つき・効いたかの目標つき）");
{
  const r = compareModes(normal, auto);
  const tasks = repeatTasks(r);
  ok("候補が出る", tasks.length >= 2, tasks.length);
  ok("最初は0円（記録の話が先）", tasks[0].cost === "0円", tasks[0].cost);
  ok("⚠ 効いたかを測れる（目標の%がある）", tasks.every((t) => t.target.includes("%")), tasks.map((t) => t.target));
  ok("「押した位置」の候補がある", tasks.some((t) => t.key === "auto_point"), tasks.map((t) => t.key));
  ok("写真学習の候補も出る（両方50%未満なので）", tasks.some((t) => t.key.startsWith("learn")), tasks.map((t) => t.key));
}

console.log("\n■ ④ 写真から学習が少ない時も候補に出す");
{
  const r = compareModes({ ...normal, withLearn: 100 }, { ...auto, withLearn: 50 });
  const tasks = repeatTasks(r);
  ok("写真から学習の候補が出る", tasks.some((t) => t.key.startsWith("learn")), tasks.map((t) => t.key));
  ok("費用が分かる（1枚0.17円）", tasks.some((t) => t.cost.includes("0.17")), tasks.map((t) => t.cost));
}

console.log("\n■ ⑤ 差が無ければ候補を出さない（誤報しない）");
{
  const same = { rows: 500, withOps: 480, withCursor: 470, withPoint: 400, withLearn: 450, withWas: 400 };
  const r = compareModes(same, same);
  ok("大きな差なし", r.weak.length === 0, r.weak);
  ok("候補も出ない", repeatTasks(r).length === 0, repeatTasks(r));
}

console.log("\n■ ⑥ 学習の質（1枚あたり何個読めたか）");
{
  const q = learnQuality([
    { learned: true, fields: 20, shot_w: 1920 },
    { learned: true, fields: 18, shot_w: 1920 },
    { learned: true, fields: 0, shot_w: 1920 },
    { learned: false, fields: 0, shot_w: 1920 },
    { learned: false, fields: 0, shot_w: 480 },
  ]);
  ok("学習した枚数", q.learnedN === 3, q.learnedN);
  ok("欄の合計", q.fields === 38, q.fields);
  ok("1枚あたり（38/3=12.7）", q.perShot === 12.7, q.perShot);
  ok("⚠ 読んだのに欄0を数える", q.emptyShots === 1, q.emptyShots);
  ok("1行で分かる", q.line.includes("1枚"), q.line);
}

console.log("\n■ ⑦ 大きい写真が少ない時に警告");
{
  const q = learnQuality([
    { learned: true, fields: 5, shot_w: 480 },
    { learned: true, fields: 5, shot_w: 480 },
    { learned: true, fields: 5, shot_w: 1920 },
  ]);
  ok("⚠ 大きい写真が少ないと警告", q.line.includes("大きい写真が少ない"), q.line);
}

console.log("\n■ ⑧ 壊れた入力でも落ちない");
{
  ok("空でも落ちない", compareModes({ rows: 0, withOps: 0, withCursor: 0, withPoint: 0, withLearn: 0, withWas: 0 }, { rows: 0, withOps: 0, withCursor: 0, withPoint: 0, withLearn: 0, withWas: 0 }).weak.length === 0);
  ok("null でも落ちない", compareModes(null as never, null as never).weak.length === 0);
  ok("learnQuality が空でも落ちない", learnQuality([]).perShot === 0);
  ok("learnQuality が null でも落ちない", learnQuality(null as never).learnedN === 0);
  ok("repeatTasks が null でも落ちない", repeatTasks(null as never).length === 0);
  /**
   * ⚠ 空のレポート（rows=0）では `learn_all`（写真学習0%）が1件出る。
   *   これは**正しい判断**（学習が0%なら次にやるべき事がある）。
   */
  ok("空のレポートでも落ちない（learn_all が1件）", repeatTasks(compareModes(null as never, null as never)).length === 1);
}

console.log("\n■ ⑨ なぜ「繰り返す」かをコードに残している");
{
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../repeat-learn.ts"), "utf8");
  ok("自動モードの押した位置7%を書いてある", /7%/.test(src));
  ok("1回直して終わりにしないと書いてある", /1回直して終わりにしない/.test(src));
  ok("数字が動かなければ直し方が違うと書いてある", /数字が動かなければ/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
