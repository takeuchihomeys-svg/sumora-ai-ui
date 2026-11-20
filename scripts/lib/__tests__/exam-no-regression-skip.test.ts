// 前が過半数で✕の問題は今を重ねて回さない（scripts/lib/exam-flake.ts の noRegressionPossible・skipNoRegressionOn）
// 実行: npx tsx scripts/lib/__tests__/exam-no-regression-skip.test.ts（全 PASS で exit 0）
// 2026-11-21 作業員H: 直近7日の試験の回の 51% が揺れる問題の重ね回し。確かな悪化（splitWorse）は「前が過半数で○→今が過半数で✕」なので、前が✕なら悪化は出ない
import { noRegressionPossible, skipNoRegressionOn, firstTwoSameAsBase, repsOnlyIfDifferOn, passPathOf } from "../exam-flake";
import { splitWorse } from "../exam-conductor-core";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const row = (passOk: boolean, pathOk: boolean, extra: Record<string, unknown> = {}) => ({ score: { pass: passOk, path: pathOk }, path: { ok: pathOk }, ...extra });

ok("既定 on・off で止まる", skipNoRegressionOn({}) && !skipNoRegressionOn({ EXAM_SKIP_NO_REGRESSION: "off" }));
ok("前の答えが無い時は言い切らない（回す）", !noRegressionPossible([]));
ok("前が4回とも✕（合格も道も）→ 悪化になりえない", noRegressionPossible([row(false, false), row(false, false), row(false, false), row(false, false)]));
ok("前が合格の過半数 → 回す", !noRegressionPossible([row(true, true), row(true, true), row(false, false), row(false, true)]));
ok("前の合格は✕でも道が過半数○ → 道の悪化がありうるので回す", !noRegressionPossible([row(false, true), row(false, true), row(false, false)]));
ok("2回で1つずつ（半分）→ 過半数ではない＝悪化の線に乗らない", noRegressionPossible([row(true, true), row(false, false)]));
ok("厳しい道（pathStrict）が過半数○なら回す", !noRegressionPossible([row(false, false, { pathStrict: true }), row(false, false, { pathStrict: true }), row(false, false)]));
ok("落ちた回（error）は数えない", noRegressionPossible([row(false, false), { error: "x", score: { pass: true }, path: { ok: true } }]));

// 係の確かな悪化の判定と矛盾しないか: 前が✕の問題は、今が何回でも splitWorse で悪化に入らない
const base = [{ id: "q1", rep: 1, score: { pass: false } }, { id: "q1", rep: 2, score: { pass: false } }, { id: "q1", rep: 3, score: { pass: true } }];
const cur1 = [{ id: "q1", rep: 1, score: { pass: false } }];
const sw = splitWorse(cur1 as never, base as never, new Set(["q1"]));
ok("前が✕の問題は今が1回✕でも確かな悪化にならない（係と同じ）", sw.sure.length === 0 && sw.flake.length === 0, sw);

// ─── 最初の2回が前と同じなら3回目から回さない（firstTwoSameAsBase・KB c6bb716c）───
{
  ok("既定 on・off で止まる", repsOnlyIfDifferOn({}) && !repsOnlyIfDifferOn({ EXAM_REPS_ONLY_IF_DIFFER: "off" }));
  const base4 = [row(true, true), row(true, true), row(true, true), row(false, true)];
  ok("2回とも前と同じ（○・道○）→ 止める", firstTwoSameAsBase([{ pass: true, path: true }, { pass: true, path: true }], base4));
  ok("1回だけでは止めない", !firstTwoSameAsBase([{ pass: true, path: true }], base4));
  ok("2回目が違う（合格✕）→ 回す", !firstTwoSameAsBase([{ pass: true, path: true }, { pass: false, path: true }], base4));
  // 実物 h1115-off-brain-cond-pickup-promis の q428: 前は道○4/4、今は1回目○・2回目が道✕（AIX:viewing_invite）→ 止めない（道の悪化を見落とさない）
  const q428base = [row(false, true), row(false, true), row(false, true), row(false, true)];
  ok("q428 の形: 2回目の道✕で止めない", !firstTwoSameAsBase([{ pass: false, path: true }, { pass: false, path: false }], q428base));
  ok("前の答えが無い時は止めない", !firstTwoSameAsBase([{ pass: true, path: true }, { pass: true, path: true }], []));
  ok("答案の行から合格と道を読む", JSON.stringify(passPathOf({ score: { pass: true }, path: { ok: false } })) === JSON.stringify({ pass: true, path: false }));
}

console.log(`exam-no-regression-skip: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
