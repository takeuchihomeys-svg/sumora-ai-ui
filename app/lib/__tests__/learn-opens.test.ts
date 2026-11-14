// 「どこで展開されるか」の学習（2026-11-14）
//
// 竹内さん「このようにボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」
//
// ・`learnOpens` … 押したら何が開いたかを欄ごとにまとめる（純関数）
// ・`planLearnFromWeak` の mode_plan … 1〜2件のモードを「0件」と言わない（実測 aix で起きていた）
//
// 実行: npx tsx app/lib/__tests__/learn-opens.test.ts
import { learnOpens, buildHumanLearnBundle, type MotionRow } from "../human-learn-brain";
import { planLearnFromWeak } from "../shot-learn";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

const NOW = Date.parse("2026-11-14T15:00:00+09:00");
const iso = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const row = (o: Partial<MotionRow>): MotionRow => ({
  created_at: iso(1), site: "realpro", mode: "normal", ext_version: "2.7.31",
  ops: 60, moves_n: 20, points_n: 10, point_x: 0.5, point_y: 0.5,
  point_fields: null, scrolls_n: 0, ...o,
});

console.log("■ ① 押したら何が開いたかを欄ごとにまとめる");
{
  const r = learnOpens([
    row({ opens: { "左の所在地絞り込み＋｜span": { opens: "modal", n: 3, stage: "form" } } }),
    row({ opens: { "左の所在地絞り込み＋｜span": { opens: "modal", n: 2, stage: "form" } } }),
    row({ opens: { "rental_cost2": { opens: "options", n: 4 } } }),
    row({ opens: { "左の検索｜span": { opens: "result", n: 5 } } }),
    row({ opens: { "確定してリストへ｜span": { opens: "modal_close", n: 6 } } }),
  ]);
  ok("小窓を開くボタン＝modal", r["左の所在地絞り込み＋｜span"]?.opens === "modal", r["左の所在地絞り込み＋｜span"]);
  ok("  回数が合わさる（3+2）", r["左の所在地絞り込み＋｜span"]?.n === 5, r["左の所在地絞り込み＋｜span"]);
  ok("  場面（stage）も残る", r["左の所在地絞り込み＋｜span"]?.stage === "form");
  ok("プルダウン＝options", r["rental_cost2"]?.opens === "options");
  ok("検索＝result", r["左の検索｜span"]?.opens === "result");
  ok("確定＝modal_close", r["確定してリストへ｜span"]?.opens === "modal_close");
}

console.log("\n■ ② 学んではいけない物は学ばない");
{
  const r = learnOpens([
    row({ opens: { "div": { opens: "modal", n: 9 } } }),
    row({ opens: { "#axlx-bar": { opens: "modal", n: 9 } } }),
    row({ opens: { "svg": { opens: "options", n: 9 } } }),
  ]);
  ok("入れ物（div/svg）は学ばない", Object.keys(r).length === 0, r);
}

console.log("\n■ ③ 壊れない");
{
  ok("空なら空", Object.keys(learnOpens([])).length === 0);
  ok("opens が無い行が混ざっても落ちない", Object.keys(learnOpens([row({}), row({ opens: null })])).length === 0);
  ok("n が 0 なら捨てる", Object.keys(learnOpens([row({ opens: { "左の検索｜span": { opens: "result", n: 0 } } })])).length === 0);
  ok("知らない形（配列）でも落ちない", Object.keys(learnOpens([row({ opens: ["x"] as unknown })])).length === 0);
}

console.log("\n■ ④ 学習の束に opens が載る（拡張まで届く）");
{
  const b = buildHumanLearnBundle([
    row({ created_at: iso(72), opens: { "左の所在地絞り込み＋｜span": { opens: "modal", n: 3 } } }),
    row({ created_at: iso(48), opens: { "rental_cost2": { opens: "options", n: 4 } } }),
  ], NOW);
  ok("束に opens が入る", !!b.opens && Object.keys(b.opens).length === 2, b.opens);
  ok("  人が読む行にも開き方が出る", b.lines.some((l) => l.includes("開き方")), b.lines.filter((l) => l.includes("開き方")));
  ok("  意味の分かる言葉で出る", b.lines.some((l) => l.includes("小窓が開く")), b.lines.filter((l) => l.includes("開き方")));
}

console.log("\n■ ⑤ 統括がモードの件数を正しく言う（0件と決めつけない）");
{
  // by_mode は3件未満を作らない。だが実数は mode_counts に入る
  const p = planLearnFromWeak([], [], {}, [], { aix: 2, normal: 10 });
  const aix = p.mode_plan.find((x) => x.mode === "aix");
  const normal = p.mode_plan.find((x) => x.mode === "normal");
  const staff = p.mode_plan.find((x) => x.mode === "staff");
  ok("2件のモードを「0件」と言わない", !!aix && !aix.verdict.includes("0件"), aix);
  ok("  あと何回かを言う", !!aix && aix.action.includes("あと1回"), aix?.action);
  /**
   * `modes`（by_mode）に無いのに 3件以上ある＝学びを作る所で落ちている。
   *   ⚠ ここを「3件に届いていない」と言うのは**嘘**（実測 normal 10件で起きていた）。
   */
  ok("3件以上あるモードは『届いていない』と言わない", !!normal && !normal.verdict.includes("届いていない"), normal);
  ok("  代わりに『作れていない』と言う", !!normal && normal.verdict.includes("作れていない"), normal);
  ok("本当に0件のモードは0件と言う", !!staff && staff.verdict.includes("0件"), staff);
}

console.log("\n■ ⑥ 既存の呼び出しを壊さない（引数4つまで）");
{
  const p = planLearnFromWeak([], [], {}, [{ kind: "交互クリック（トグル跡）", n: 24 }]);
  ok("ゴミの整理は今まで通り効く", p.cleanup.length === 1 && p.cleanup[0].verdict.includes("除いています"), p.cleanup);
  const p2 = planLearnFromWeak([], [], {});
  ok("引数3つでも動く", Array.isArray(p2.mode_plan));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
