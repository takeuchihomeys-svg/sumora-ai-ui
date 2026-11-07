// 試験の統括（scripts/lib/exam-plan.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-plan.test.ts（全 PASS で exit 0）
import { flakeCleanSinceMs } from "../exam-flake";
import { planExam, guessKind, kindSuggest, readExamResult, weeklyPlanAudit, splitCmdArgs, overBudget, capUsdOf, needsBaseIds, planVsActualReport, specMissingIds, runBaseCheck, pathRegressions, bizLanes } from "../exam-plan";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const OFF = Date.parse("2026-11-07T12:00:00Z"), PEAK = Date.parse("2026-11-04T02:00:00Z");

ok("種類: 推定で物差しに回さない（_NOTE は判断を変えうる）", guessKind({ switchName: "PROMISE_DUE_NOTE" }) === "exam" && guessKind({ switchName: "BRAIN_DIGEST_X" }) === "exam");
ok("種類: 記録らしい名前は勧めるだけ", kindSuggest({ switchName: "BRAIN_DIGEST_X" }) !== null && kindSuggest({ switchName: "PROMISE_DUE_NOTE" }) === null);
ok("種類: 書いた物で決める", guessKind({ kind: "prod", switchName: "X" }) === "prod");
{
  const p = planExam({ label: "rec1", kind: "record", switchName: "SENT_CONFIRMED_NOTE", ids: ["q1", "q2"] });
  ok("記録だけ→物差しで見る・費用0", p.route === "yardstick" && p.cost.usd === 0 && /本番の物差し/.test(p.line));
}
{
  const p = planExam({ label: "a", ids: ["q1", "q2", "q3"], history: { q1: [true, true, true], q2: [true, false, true] }, regression: ["q9"], diffStage: "brain", atMs: OFF, k: 3 });
  ok("回数: 安定1・揺れ k・分からない k・回帰2", p.reps.q1 === 1 && p.reps.q2 === 3 && p.reps.q3 === 3 && p.reps.q9 === 3 && p.ids.includes("q9"), JSON.stringify(p.reps));
  ok("段: diff が brain → brain", p.stage === "brain");
  ok("Claude: 既定 off のままは要らない", p.claude.ids.length === 0);
  ok("1行の計画", /^計画 a: 問題 4（回帰 1）/.test(p.line) && p.line.includes("段 brain"), p.line);
  ok("今流す（安い時間・上限の内）", p.gate.go);
}
{
  const p = planExam({ label: "b", ids: Array.from({ length: 30 }, (_, i) => `q${i}`), group: "reply", atMs: PEAK, capUsd: 2 });
  ok("文の組は draft", p.stage === "draft");
  ok("倍の時間で上限を超える→夜か分ける", !p.gate.go, p.line);
}
{
  const p = planExam({ label: "c", ids: ["q1"], brainText: true, defaultOn: true, scenes: [{ scene: "見積", problems: ["q1"] }], atMs: OFF });
  ok("Claude: 指示の文を変えて既定 on → 場面ごとに1問", p.claude.ids.join(",") === "q1");
}
{
  const r0 = readExamResult([{ id: "q1", cmp: "same" }, { id: "q2", cmp: "better" }]);
  ok("結果: 悪化0", r0.verdict === "悪化0");
  const r1 = readExamResult([{ id: "q1", cmp: "worse", sure: true }, { id: "q2", cmp: "same" }], [{ id: "q1", staffText: "かしこまりました！！ 確認させて頂きます", brainPath: "AIX:estimate_sheet", basePath: "返信" }]);
  ok("結果: 確かな悪化＋竹内さんの送信と答案の差", r1.verdict === "確かな悪化" && r1.dig.length === 1 && r1.line.includes("竹内さん「かしこまりました") && r1.line.includes("前 返信 → 今 AIX:estimate_sheet"), r1.line);
  const r2 = readExamResult([{ id: "q1", cmp: "worse", sure: false }]);
  ok("結果: 揺れ", r2.verdict === "揺れ");
  ok("結果: 比べられない", readExamResult([{ id: "q1", cmp: "nobase" }]).verdict === "比べられない");
}
{
  const a = weeklyPlanAudit([
    { at: "x", label: "e1", route: "exam", ids: ["q1"], usd: 0.5, result: { verdict: "悪化0", worse: [], sameAll: true, ranUsd: 0.4 } },
    { at: "x", label: "e2", route: "exam", ids: ["q1"], usd: 0.5, result: { verdict: "確かな悪化", worse: ["q1"] } },
    { at: "x", label: "y1", route: "yardstick", ids: [], usd: 0 },
    { at: "x", label: "y2", route: "yardstick", ids: [], usd: 0 },
  ], { y2: 1 });
  ok("毎週: むだ1（$0.40）・見落とし1", a.wasted === 1 && Math.abs(a.wastedUsd - 0.4) < 1e-9 && a.missed === 1, a.line);
}

ok("cmd の割り: = の後ろの引用符に空白（作業員4 ci-v1L）", JSON.stringify(splitCmdArgs("scripts/exam-aix-text.ts --label=a --qfile=\"C:/Users/竹内 悠馬/a.json\" --kinds=second")) === JSON.stringify(["scripts/exam-aix-text.ts", "--label=a", "--qfile=C:/Users/竹内 悠馬/a.json", "--kinds=second"]));
ok("cmd の割り: 丸ごと引用符", JSON.stringify(splitCmdArgs("a \"b c\" d")) === JSON.stringify(["a", "b c", "d"]));
ok("cmd の割り: 引用符なし", splitCmdArgs("x  y").join("|") === "x|y");

ok("揺れの記録: 既定は 11/05 の直しの後だけ読む", flakeCleanSinceMs({}) === Date.parse("2026-11-05T05:30:00Z"));
ok("揺れの記録: off で前の記録も読む", flakeCleanSinceMs({ EXAM_FLAKE_CLEAN_SINCE: "off" }) === 0);
ok("揺れの記録: 時刻を変えられる", flakeCleanSinceMs({ EXAM_FLAKE_CLEAN_SINCE: "2026-11-06T00:00:00Z" }) === Date.parse("2026-11-06T00:00:00Z"));

ok("上限: 届いたら止める", overBudget(1.0, 1.0) && overBudget(1.2, 1.0) && !overBudget(0.9, 1.0));
ok("上限: 無い・0・変な値は止めない", !overBudget(99, null) && !overBudget(99, 0) && !overBudget(NaN, 1));
ok("上限の環境変数", capUsdOf({ EXAM_MAX_USD: "0.5" }) === 0.5 && capUsdOf({}) === null && capUsdOf({ EXAM_MAX_USD: "x" }) === null && capUsdOf({ EXAM_MAX_USD: "0" }) === null);

{
  // 11/06 統括役: 係が実際に流す回数を渡されたら見込みはその回数（作業員9 の q010・1回の依頼が3回分 $0.18 と出た）
  const before = planExam({ label: "d0", ids: ["q010"], diffStage: "draft", atMs: OFF });
  const after = planExam({ label: "d1", ids: ["q010"], diffStage: "draft", atMs: OFF, repsOverride: { q010: 1 } });
  ok("回数の指定で見込みが1回分", before.reps.q010 === 3 && after.reps.q010 === 1 && Math.abs(after.cost.usd * 3 - before.cost.usd) < 1e-9 && after.line.includes("安定1×1"), `${before.cost.usd} ${after.cost.usd} ${after.line}`);
  const mix = planExam({ label: "d2", ids: ["a", "b"], atMs: OFF, repsOverride: { a: 4 } });
  ok("渡されない問題は今までの推定", mix.reps.a === 4 && mix.reps.b === 3 && mix.line.includes("揺れ4×2"), mix.line);
}

{
  // 11/06 統括役（sce-on2 見込み $0.24・実際 $0.35＝前を作った子の分が入っていなかった）
  const vk = { c1: "k1" };
  const dirs = (k: string) => (k === "k1" ? [["q084", "q079"], ["q008"]] : []);
  ok("前の答えが今の版にある問題は作らない", needsBaseIds(["q084", "q008", "q999"], { mainCommit: "c1", versionKeys: vk, dirsByKey: dirs }).join(",") === "q999");
  ok("今の版の鍵が無い（main が動いた）＝全部作る", needsBaseIds(["q084", "q008"], { mainCommit: "c2", versionKeys: vk, dirsByKey: dirs }).length === 2);
  const a = planExam({ label: "s0", ids: ["q084", "q079"], diffStage: "brain", atMs: OFF, repsOverride: { q084: 4, q079: 4 } });
  const b = planExam({ label: "s1", ids: ["q084", "q079"], diffStage: "brain", atMs: OFF, repsOverride: { q084: 4, q079: 4 }, needsBase: ["q084", "q079"] });
  ok("前を作る分を見込みに足す（sce-on2 の形で約2倍）", Math.abs(b.cost.usd - 2 * a.cost.usd) < 1e-9 && b.line.includes("前を作る分 $0.24"), b.line);
  const r = planVsActualReport([{ label: "x", stage: "brain", planUsd: 0.24, cur: 0.17, judge: 0.01, base: 0.17, reps: 8 }, { label: "y", stage: "draft", planUsd: 0.36, cur: 0.18, judge: 0, base: 0.18, reps: 5 }]);
  ok("見込みと実際の比の一覧", r.lines.length === 2 && r.lines[0].includes("比 1.46") && Math.abs(r.byStage.brain.perRep - 0.0225) < 1e-9 && r.byStage.draft.ratioMid === 1, JSON.stringify(r));
}

ok("spec に無い問題（古い作業ツリー・sorry-read-dig-1107 の q354〜q357）", specMissingIds(["q354", "q355", "q010"], ["q010", "q011"]).join(",") === "q354,q355" && specMissingIds(["q010"], ["q010"]).length === 0);

{
  // 11/07 統括役（on2-brainask-p1: 上限 $0.2・前の作り直しで使い切り今の回0問）
  const r = runBaseCheck({ reps: { q1: 2, q2: 2 }, needsBase: ["q1", "q2"], unitUsd: 0.04, capUsd: 0.2 });
  ok("前を作る分で上限を超える → 流さない", !r.go && Math.abs(r.baseUsd - 0.16) < 1e-9 && Math.abs(r.curUsd - 0.16) < 1e-9 && r.line.includes("上限 $0.20 を超える"), r.line);
  ok("前が要らなければ流す", runBaseCheck({ reps: { q1: 2, q2: 2 }, needsBase: [], unitUsd: 0.04, capUsd: 0.2 }).go);
  ok("上限が無ければ流す（見込みは出す）", runBaseCheck({ reps: { q1: 2 }, needsBase: ["q1"], unitUsd: 0.04, capUsd: null }).go);
}

{
  // 11/07 統括役（proc-line-dig3-1107: q092 2段:check→返信・合格は ✕→✕）
  const base = [{ id: "q092", path: { code: "2段:check", ok: true } }, { id: "q374", path: { code: "返信", ok: false } }, { id: "q1", path: { code: "返信", ok: true } }, { id: "q1", path: { code: "返信", ok: true } }];
  const cur = [{ id: "q092", path: { code: "返信", ok: false } }, { id: "q374", path: { code: "2段:check", ok: true } }, { id: "q1", path: { code: "返信", ok: true } }, { id: "q1", path: { code: "AIX:x", ok: false } }];
  const r = pathRegressions(cur, base, ["q092", "q374", "q1"]);
  ok("道の悪化: 正解の道から外れた問題だけ（良くなった・揺れの半分は入れない）", r.length === 1 && r[0].id === "q092" && r[0].from === "2段:check" && r[0].to === "返信" && r[0].why === "1/1→0/1", JSON.stringify(r));
  ok("本質の悪化も同じ数え方", pathRegressions([{ id: "a", essence: { code: "AIX:x", ok: false } }], [{ id: "a", essence: { code: "返信", ok: true } }], ["a"], "essence").length === 1);
  ok("前か今が無い問題は数えない", pathRegressions([], base, ["q092"]).length === 0);
}

// 11/07 統括役: 土日の営業時間はレーン2本・平日は1本・営業時間の外は係の既定
ok("レーン: 土曜 10時は2本・金曜 10時は1本・土曜 23時は既定", bizLanes(new Date("2026-11-07T01:00:00Z")) === 2 && bizLanes(new Date("2026-11-06T01:00:00Z")) === 1 && bizLanes(new Date("2026-11-07T14:00:00Z")) === null && bizLanes(new Date("2026-11-08T01:00:00Z"), { EXAM_WEEKEND_LANES: "1" }) === 1 && bizLanes(new Date("2026-11-06T01:00:00Z"), { EXAM_BIZ_ONE_LANE: "off" }) === null);

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
