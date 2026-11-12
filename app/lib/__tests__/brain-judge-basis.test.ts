// npx tsx app/lib/__tests__/brain-judge-basis.test.ts
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { brainJudgeBasisOn, brainJudgeBasisOutputItem, normalizeJudgeBasis, BRAIN_JUDGE_BASIS_FIELD } from "../brain-judge-basis";
import { ORDER_ROLES, FOCUS_KINDS, DEPTH_KINDS } from "../judge-basis-types";
import { goldOf, scoreTurn, buildReport, inferFocusFromAccept, formatReport } from "../../../scripts/lib/judge-basis-score";
import { FOCUS_ORDER } from "../conductor-focus";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off＝出力の指定は1文字も変わらない", () => {
  assert.equal(brainJudgeBasisOn({}), false);
  assert.equal(brainJudgeBasisOutputItem({}), "");
  assert.equal(brainJudgeBasisOutputItem({ BRAIN_JUDGE_BASIS: "off" }), "");
});
t("on＝判断を書き終えた後の書き終えた後のメモと明記・型の名前は1か所から", () => {
  const s = brainJudgeBasisOutputItem({ BRAIN_JUDGE_BASIS: "on" });
  assert.match(s, /全部書き終えた後で JSON の一番最後/);
  assert.match(s, /道・AIX・返信の方向を変えない/);
  for (const k of FOCUS_KINDS) assert.ok(s.includes(k));
  for (const k of DEPTH_KINDS) assert.ok(BRAIN_JUDGE_BASIS_FIELD.includes(k));
  for (const r of ORDER_ROLES) assert.ok(s.includes(r));
});
const raw = {
  clues: ["初期費用が高い", "見積後の返信", ""], depth: "deep", depth_clue: "不安の言葉", depth_why: "背景に予算",
  readings: [{ reading: "費用を知りたい", focus: "answer" }, { reading: "高くて不安", focus: "ease" }, { reading: "x", focus: "bogus" }], chosen: 1, chosen_why: "不安の言葉が強い",
  priority: ["ease_worry", "answer_question", "ease_worry", "nope"], focus: "ease", order: ["judge", "deep", "zzz", "writer"], order_why: "不安から",
};
t("読み取り: 一覧の外は捨てる・重複と空は除く・壊れた物は null", () => {
  const l = normalizeJudgeBasis(raw)!;
  assert.deepEqual(l.clues, ["初期費用が高い", "見積後の返信"]);
  assert.equal(l.depth, "deep");
  assert.equal(l.readings[2].focus, null);
  assert.equal(l.chosen, 1);
  assert.deepEqual(l.priority, ["ease_worry", "answer_question"]);
  assert.deepEqual(l.order, ["judge", "deep", "writer"]);
  assert.equal(normalizeJudgeBasis({}), null);
  assert.equal(normalizeJudgeBasis("x"), null);
  assert.equal(normalizeJudgeBasis({ chosen: 5, focus: "answer", readings: [] })!.chosen, null);
});
t("正解: spec.basis は human・無ければ accept の AIX 型から重点だけ推定", () => {
  assert.equal(goldOf({ id: "a", basis: { focus: "ease" } }).source, "human");
  assert.deepEqual(goldOf({ id: "a", basis: { focus: "ease" } }).order, FOCUS_ORDER.ease.map((s) => s.role).filter((r, i, a) => a[i - 1] !== r));
  assert.equal(inferFocusFromAccept(["AIX:viewing_invite"]), "close");
  assert.equal(inferFocusFromAccept(["AIX:左右"]), null);
  assert.equal(inferFocusFromAccept(["返信"]), null);
  assert.equal(goldOf({ id: "a", accept: ["AIX:cost_explain"] }).source, "inferred");
  assert.equal(goldOf({ id: "a", accept: ["返信"] }).source, "none");
});
const spec = { id: "q1", type: "費用", basis: { focus: "ease" as const, depth: "deep" as const, priority: ["ease_worry" as const] } };
const brainOf = (log: unknown, path = true) => ({ id: "q1", rep: 1, brain: { judge_basis: log }, score: { path } });
t("外れた段: 読み→選び→深さ→優先→重点→順番→道の順に先の1つ", () => {
  const ok = scoreTurn(spec, brainOf({ ...raw, order: FOCUS_ORDER.ease.map((s) => s.role) }));
  assert.equal(ok.missStage, null); assert.equal(ok.orderExact, true); assert.equal(ok.focusHit, true);
  assert.equal(scoreTurn(spec, brainOf({ ...raw, readings: [{ reading: "a", focus: "answer" }], chosen: 0 })).missStage, "read");
  assert.equal(scoreTurn(spec, brainOf({ ...raw, chosen: 0 })).missStage, "pick");
  assert.equal(scoreTurn(spec, brainOf({ ...raw, depth: "shallow" })).missStage, "depth");
  assert.equal(scoreTurn(spec, brainOf({ ...raw, priority: ["next_step"] })).missStage, "priority");
  assert.equal(scoreTurn(spec, brainOf({ ...raw, focus: "close" })).missStage, "focus");
  assert.equal(scoreTurn(spec, brainOf({ ...raw, order: ["writer", "judge"] })).missStage, "order");
  assert.equal(scoreTurn(spec, brainOf({ ...raw, order: FOCUS_ORDER.ease.map((s) => s.role) }, false)).missStage, "path");
});
t("judge_basis が無い答案でも conductor_focus の重点を数える・深さは none", () => {
  const v = scoreTurn(spec, { id: "q1", brain: { conductor_focus: { focus: "ease" } }, score: { path: true } });
  assert.equal(v.focusHit, true); assert.equal(v.depth, "none"); assert.equal(v.orderExact, null);
});
t("集計: 場面別・深さ別・外れた段・選んだ順番の当たり", () => {
  const okOrder = FOCUS_ORDER.ease.map((s) => s.role);
  const r = buildReport([spec, { id: "q2", type: "内覧", accept: ["AIX:viewing_invite"] }, { id: "q3", accept: ["返信"] }], [
    brainOf({ ...raw, order: okOrder }), brainOf({ ...raw, depth: "shallow", order: ["writer"] }),
    { id: "q2", brain: { judge_basis: { focus: "close", depth: "normal" } }, score: { path: true } }, { id: "q3", brain: {} }, { id: "zz", brain: {} },
  ]);
  assert.equal(r.noSpec, 1); assert.equal(r.noGold, 1);
  assert.equal(r.byScene["費用"].n, 2); assert.equal(r.byScene["費用"].ordExact, 1);
  assert.equal(r.byDepth["deep"].n, 1); assert.equal(r.byDepth["shallow"].miss.depth, 1);
  assert.equal(r.byScene["内覧"].focusHit, 1);
  assert.match(formatReport(r), /場面ごと/);
});
t("spec の basis（人が付けた正解）: 重点は一覧の中・by あり", () => {
  const spec = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as Array<{ id: string; type?: string; basis?: { focus?: string; by?: string } }>;
  const withBasis = spec.filter((x) => x.basis);
  assert.ok(withBasis.length >= 25);
  for (const x of withBasis) { assert.ok((FOCUS_KINDS as readonly string[]).includes(x.basis!.focus ?? ""), x.id); assert.ok(x.basis!.by, x.id); assert.equal(goldOf(x as never).source, "human"); }
  assert.ok(new Set(withBasis.map((x) => x.basis!.focus)).size >= 6);
});
console.log(`${n} tests passed`);
