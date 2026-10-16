// 試験のブレイン（scripts/lib/exam-brain.ts）の決め方の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-brain.test.ts（全 PASS で exit 0）
import {
  mergePicks, firstReps, confirmTargets, draftEligible, draftTargets, compareProblem, brainChangedOf, stopDecision, isCheapWindow, nextCheapStart, decideWhen,
  reuseKey, kbKeyOf, canReuse, modelOf, estimateUsd, needJudge, type PlanProblem, type RowLite,
} from "../exam-brain";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const P = (id: string, type = "t", accept = ["返信"], tags: string[] = []): PlanProblem => ({ id, type, accept, tags });
const all = [P("q1"), P("q2", "t", ["AIX:x"]), P("q3", "t", ["返信"], ["お手本"]), P("q4"), P("q5", "u", ["2段:check"], ["竹内さんの番"])];

// 1. どの問題
{
  const r = mergePicks(all, { mode: "rag", picked: [{ id: "q1", why: ["差分の言葉に近い"], must: false }] }, { named: ["q4"], weakSpotProblems: { q2: ["abcdef12"] } });
  const ids = r.map((x) => x.id);
  ok("RAG＋名指し＋お手本＋竹内さんの番＋弱い所", ids.join() === "q1,q2,q3,q4,q5", ids.join());
  ok("RAG だけの問題は must でない", r.find((x) => x.id === "q1")!.must === false);
  ok("お手本は必ず", r.find((x) => x.id === "q3")!.must);
  ok("gate は全部", mergePicks(all, null, { gate: true }).length === 5);
  ok("選びが無い時は全部（安全側）", mergePicks(all, null, {}).length === 5);
  ok("無い id は足さない", !mergePicks(all, { mode: "rag", picked: [] }, { named: ["q999"] }).some((x) => x.id === "q999"));
}
// 2. 何回
ok("揺れる問題だけ3回", firstReps("flaky") === 3 && firstReps("stable") === 1 && firstReps("unknown") === 1);
ok("確かめは前と違った問題（揺れる問題は既に3回）", confirmTargets([{ id: "a", cmp: "worse" }, { id: "b", cmp: "same" }, { id: "c", cmp: "better" }, { id: "d", cmp: "worse" }], new Set(["d"])).join() === "a,c");
ok("はっきり良い時は良くなった問題だけ", confirmTargets([{ id: "a", cmp: "changed" }, { id: "c", cmp: "better" }], new Set(), { clearlyGood: true }).join() === "c");
// 3. どこまで
ok("下書きの意味: AIX だけの正解は無し", !draftEligible(all[1]) && draftEligible(all[0]));
ok("下書きの意味: 出し切りの正解も見る", draftEligible({ id: "x", type: "t", accept: ["AIX:z"], acceptWhen: { searchExhausted: ["返信"] } }));
ok("下書きに効く変更は全部の候補", draftTargets("draft", all, new Set()).ids.join() === "q1,q3,q4,q5");
ok("ブレインだけの変更は判断が変わった問題だけ", draftTargets("brain", all, new Set(["q4", "q2"])).ids.join() === "q4");
ok("変更なし・判断も同じは0", draftTargets("none", all, new Set()).ids.length === 0);
ok("gate は全部の候補", draftTargets("none", all, new Set(), { gate: true }).ids.length === 4);
// 比べ
const R = (ok1: boolean, pass1: boolean, code = "返信", d?: boolean): RowLite => ({ id: "x", rep: 1, path: { code, ok: ok1 }, score: { pass: pass1 }, draft: d === undefined ? null : { pass: d } });
ok("道が悪化", compareProblem([R(false, false)], [R(true, true)]).cmp === "worse");
ok("合格だけ良くなった", compareProblem([R(true, true)], [R(true, false)]).cmp === "better");
ok("判断だけ変わった", compareProblem([R(true, true, "2段:check")], [R(true, true, "返信")]).cmp === "changed");
ok("下書きの悪化", compareProblem([R(true, true, "返信", false)], [R(true, true, "返信", true)]).cmp === "worse");
ok("過半数で見る", compareProblem([R(true, true), R(true, true), R(false, false)], [R(true, true)]).cmp === "same");
ok("前が無い", compareProblem([R(true, true)], []).cmp === "nobase");
ok("失敗の行は数えない", compareProblem([{ id: "x", rep: 1, error: "e" }], [R(true, true)]).cmp === "nocur");
ok("判断が変わった集合", [...brainChangedOf([{ id: "a", cmp: "same" }, { id: "b", cmp: "changed" }, { id: "c", cmp: "nobase" }])].join() === "b,c");
// 5. 途中で止める
{
  const cm = (xs: string) => xs.split(",").map((c, i) => ({ id: `p${i}`, cmp: c as never }));
  ok("はっきり悪化で止める", stopDecision(cm("worse,worse,worse,same"), new Set()).action === "stop");
  ok("数が少ない内は止めない", stopDecision(cm("worse,worse,worse"), new Set()).action === "go");
  ok("揺れる問題の悪化は数えない", stopDecision(cm("worse,worse,worse,same,same"), new Set(["p0"])).action === "go");
  ok("良くなった分を差し引く", stopDecision(cm("worse,worse,worse,better,better"), new Set()).action === "go");
  ok("はっきり良い", stopDecision(cm("better,better,better,same"), new Set()).action === "fewer");
}
// 4. いつ（JST 1:30〜9:30・混雑の外）
{
  const at = (jst: string) => new Date(Date.parse(`${jst}+09:00`));
  ok("JST 3:00 は安い", isCheapWindow(at("2026-10-19T03:00:00")));
  ok("JST 9:30 は安くない", !isCheapWindow(at("2026-10-19T09:30:00")));
  ok("JST 11:00（混雑）は安くない", !isCheapWindow(at("2026-10-19T11:00:00")));
  ok("JST 23:00 → 翌 1:30", nextCheapStart(at("2026-10-19T23:00:00")).toISOString() === at("2026-10-20T01:30:00").toISOString(), nextCheapStart(at("2026-10-19T23:00:00")).toISOString());
  ok("JST 0:10 → 当日 1:30", nextCheapStart(at("2026-10-19T00:10:00")).toISOString() === at("2026-10-19T01:30:00").toISOString());
  ok("小さい試験は今", decideWhen({ when: "auto", estUsd: 0.3, now: at("2026-10-19T11:00:00") }).runNow);
  ok("関所は昼なら予約", !decideWhen({ when: "auto", estUsd: 0.3, gate: true, now: at("2026-10-19T11:00:00") }).runNow);
  ok("関所でも安い時間なら今", decideWhen({ when: "auto", estUsd: 5, gate: true, now: at("2026-10-19T03:00:00") }).runNow);
  ok("now は今", decideWhen({ when: "now", estUsd: 9, gate: true, now: at("2026-10-19T11:00:00") }).runNow);
}
// 6. 使い回し
{
  const base = { problemHash: "h", stage: "brain" as const, scopeKey: "s", toolKey: "t", cfgHash: "c", model: "m", kbKey: "k" };
  const k = reuseKey(base);
  ok("鍵は使う物が同じなら同じ", k === reuseKey({ ...base }));
  ok("効くファイルが変われば別", k !== reuseKey({ ...base, scopeKey: "s2" }) && k !== reuseKey({ ...base, kbKey: "k2" }) && k !== reuseKey({ ...base, stage: "draft" }));
  ok("知見の版は紐付く物だけ", kbKeyOf([{ kbId: "a" }], { a: "1", b: "2" }) === kbKeyOf([{ kbId: "a" }], { a: "1", b: "3" }) && kbKeyOf([{ kbId: "a" }], { a: "1" }) !== kbKeyOf([{ kbId: "a" }], { a: "9" }));
  const now = Date.parse("2026-10-17T00:00:00Z");
  const e = { key: k, savedAt: "2026-10-16T00:00:00Z", rows: [R(true, true)] };
  ok("使い回せる", canReuse(e, k, 1, now));
  ok("回数が足りないと使わない", !canReuse(e, k, 3, now));
  ok("古いと使わない", !canReuse({ ...e, savedAt: "2026-10-01T00:00:00Z" }, k, 1, now));
  ok("鍵が違うと使わない", !canReuse(e, "x", 1, now));
  ok("失敗の行があると使わない", !canReuse({ ...e, rows: [R(true, true), { id: "x", rep: 2, error: "e" }] }, k, 1, now));
}
// 8. モデル
ok("既定は pro", modelOf(all[0], { mode: "pro", flashOkTypes: new Set(["t"]) }) === "pro");
ok("auto は比べで良かった型だけ flash", modelOf(all[0], { mode: "auto", flashOkTypes: new Set(["t"]) }) === "flash" && modelOf(all[4], { mode: "auto", flashOkTypes: new Set(["t"]) }) === "pro");
ok("関所は常に pro", modelOf(all[0], { mode: "flash", flashOkTypes: new Set(), gate: true }) === "pro");
// 見込み
{
  const e = estimateUsd([{ id: "a", reps: 1, draft: false, reuse: false, model: "pro", why: [] }, { id: "b", reps: 3, draft: true, reuse: false, model: "pro", why: [] }, { id: "c", reps: 1, draft: false, reuse: true, model: "pro", why: [] }]);
  ok("見込み: 使い回しは0", Math.abs(e.now - (0.03 + 0.045 * 3)) < 1e-9, String(e.now));
}
// 7. 採点
ok("依頼も禁止も無い時は呼ばない", !needJudge({ asks: 0, ng: 0, needRawPath: false, pathOk: true, lazy: false }));
ok("lazy: 道が外れ・本質も決まりなら呼ばない", !needJudge({ asks: 2, ng: 1, needRawPath: false, pathOk: false, lazy: true }));
ok("lazy: 本質の道が要れば呼ぶ", needJudge({ asks: 2, ng: 0, needRawPath: true, pathOk: false, lazy: true }));
ok("lazy: 道が合えば呼ぶ", needJudge({ asks: 2, ng: 0, needRawPath: false, pathOk: true, lazy: true }));

console.log(`exam-brain: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
