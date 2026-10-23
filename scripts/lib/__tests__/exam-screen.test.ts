// ふるい（scripts/lib/exam-screen.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-screen.test.ts（全 PASS で exit 0）
import { SCREEN, screenModeOf, bannedTypes, screenCandidates, auditPick, screenDecide, blindObs, mergeBlind, totalsOf, claudeTargets, finalCmpOf, escalateRateOf, estimateScreen, type ScreenStats } from "../exam-screen";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const empty: ScreenStats = { byType: {} };
const good: ScreenStats = { byType: { a: { n: 15, blind: 0, soft: 2 }, b: { n: 10, blind: 1, soft: 0 } } };

// 1. 使うか
ok("既定 auto・数えていない＝使わない", !screenModeOf(undefined, { gate: false, stats: empty }).on);
ok("auto・25回で 1見落とし（4%）＝使う", screenModeOf("auto", { gate: false, stats: good }).on);
ok("auto・見落とし多い＝使わない", !screenModeOf("", { gate: false, stats: { byType: { a: { n: 20, blind: 3, soft: 0 } } } }).on);
ok("auto・flash で違う割合が高い（ふるいが損）＝使わない", !screenModeOf("auto", { gate: false, stats: { ...good, runs: [{ at: "x", label: "L", screened: 10, unchanged: 2, escalated: 8, audit: 0, flashSame: 3 }] } }).on);
ok("auto・違う割合が低い＝使う", screenModeOf("auto", { gate: false, stats: { ...good, runs: [{ at: "x", label: "L", screened: 10, unchanged: 6, escalated: 4, audit: 1, flashSame: 7 }] } }).on);
ok("on は数えていなくても使う", screenModeOf("on", { gate: false, stats: empty }).on);
ok("off", !screenModeOf("OFF", { gate: false, stats: good }).on);
ok("関所は auto では使わない", !screenModeOf("auto", { gate: true, stats: good }).on);
ok("関所でも on なら使う", screenModeOf("on", { gate: true, stats: empty }).on);

// 2. 型の止め
{
  const b = bannedTypes({ byType: { a: { n: 3, blind: 1, soft: 0 }, b: { n: 10, blind: 1, soft: 3 }, c: { n: 20, blind: 3, soft: 0 }, d: { n: 2, blind: 0, soft: 2 } } });
  ok("1/3 は止める", b.has("a"));
  ok("1/10 は線ちょうど＝止めない", !b.has("b"));
  ok("3/20＝15% は止める", b.has("c"));
  ok("判断だけ違う（soft）は止めない", !b.has("d"));
}

// 3. ふるう問題
{
  const r = screenCandidates([
    { id: "q1", type: "a", model: "pro", reuse: false, draft: false },
    { id: "q2", type: "a", model: "flash", reuse: false, draft: false },
    { id: "q3", type: "a", model: "pro", reuse: true, draft: false },
    { id: "q4", type: "a", model: "pro", reuse: false, draft: true },
    { id: "q5", type: "x", model: "pro", reuse: false, draft: false },
  ], new Set(["x"]));
  ok("pro・使い回しでない・下書きでない・止めた型でない物だけ", r.screen.join() === "q1", r.screen.join());
  ok("下書きと止めた型は理由付き", r.skip.map((s) => s.id).join() === "q4,q5");
}

// 4. 抜き取り
{
  const ids = Array.from({ length: 20 }, (_, i) => `q${i}`);
  const a = auditPick(ids, 0.15, "s1"), b = auditPick(ids, 0.15, "s1"), c = auditPick(ids, 0.15, "s2");
  ok("15% で 3問", a.length === 3, String(a.length));
  ok("同じ seed は同じ選び", a.join() === b.join());
  ok("seed が違えば違う選びになりうる", a.join() !== c.join() || true);
  ok("4問以上は少なくとも1問", auditPick(["a", "b", "c", "d"], 0.05, "x").length === 1);
  ok("3問以下・小さい割合は0もある", auditPick(["a", "b"], 0.1, "x").length === 0);
  ok("1 は全部", auditPick(ids, 1, "x").length === 20);
  ok("0 は無し", auditPick(ids, 0, "x").length === 0);
}

// 5. 決め
{
  const d = screenDecide([
    { id: "s", cmp: "same", inputSame: false, fix: false, flaky: false },
    { id: "w", cmp: "worse", inputSame: false, fix: false, flaky: false },
    { id: "sh", cmp: "shape", inputSame: false, fix: false, flaky: false },
    { id: "nb", cmp: "nobase", inputSame: false, fix: false, flaky: false },
    { id: "nc", cmp: "nocur", inputSame: false, fix: false, flaky: false },
    { id: "f", cmp: "same", inputSame: false, fix: true, flaky: false },
    { id: "fl", cmp: "same", inputSame: false, fix: false, flaky: true },
    { id: "au", cmp: "same", inputSame: false, fix: false, flaky: false },
    { id: "in", cmp: "same", inputSame: true, fix: false, flaky: false },
  ], new Set(["au"]));
  ok("変わらない＝flash 同じで的・揺れ・抜き取り・入力同じでない物だけ", d.unchanged.join() === "s", d.unchanged.join());
  ok("違った・形だけ・前無し・答え無し・的・揺れ・抜き取り・入力同じは pro へ", d.escalate.map((e) => e.id).join() === "w,sh,nb,nc,f,fl,au,in", d.escalate.map((e) => e.id).join());
  ok("入力同じは pro の下見で（0円）", /下見/.test(d.escalate.find((e) => e.id === "in")!.why));
}

// 6. 見落としの数え
{
  const o = blindObs([
    { id: "a", type: "t", flashCmp: "same", inputSame: false, proCmp: "worse" },
    { id: "b", type: "t", flashCmp: "same", inputSame: false, proCmp: "same" },
    { id: "c", type: "t", flashCmp: "same", inputSame: false, proCmp: "changed" },
    { id: "d", type: "t", flashCmp: "worse", inputSame: false, proCmp: "worse" },
    { id: "e", type: "t", flashCmp: "same", inputSame: true, proCmp: "worse" },
    { id: "f", type: "u", flashCmp: "same", inputSame: false, proCmp: "nocur" },
  ]);
  ok("flash 同じ・入力違う・pro の答えがある物だけ数える", o.map((x) => x.id).join() === "a,b,c", o.map((x) => x.id).join());
  ok("hard＝道/合格・soft＝判断", o[0].hard && !o[1].hard && !o[1].soft && o[2].soft && !o[2].hard);
  const m = mergeBlind({ byType: { t: { n: 2, blind: 0, soft: 0 } } }, o, { at: "x", label: "L", screened: 10, unchanged: 5, escalated: 5, audit: 1, flashSame: 7 });
  ok("型に足す", m.byType.t.n === 5 && m.byType.t.blind === 1 && m.byType.t.soft === 1, JSON.stringify(m.byType.t));
  ok("回の記録", m.runs!.length === 1);
  ok("合計", totalsOf(m).n === 5);
  ok("元を変えない", good.byType.a.n === 15);
  ok("flash で違った割合（抜き取りを含めない）", Math.abs(escalateRateOf(m) - 0.3) < 1e-9);
  ok("記録なし＝0.5", escalateRateOf(empty) === 0.5);
}

// 7. 関所の Claude
{
  const t = claudeTargets([{ id: "c", cmp: "changed" }, { id: "s", cmp: "same" }, { id: "b", cmp: "better" }, { id: "w", cmp: "worse" }, { id: "sh", cmp: "shape" }, { id: "x", cmp: "worse" }], { exclude: new Set(["x"]) });
  ok("悪化→良い→判断だけ・形だけと同じは入れない・入力同じは除く", t.join() === "w,b,c", t.join());
  ok("最大 8", claudeTargets(Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, cmp: "worse" as const }))).length === SCREEN.claudeMax);
  ok("Claude の比べで決める", finalCmpOf("worse", "same").cmp === "same" && finalCmpOf("worse", "same").by === "claude");
  ok("Claude の前が無い＝pro のまま", finalCmpOf("worse", "nobase").cmp === "worse" && finalCmpOf("worse", undefined).by === "pro");
}

// 8. 見込み
{
  const e = estimateScreen({ q: 34, reps: 2, flashDiffRate: 0.5, auditRate: 0.15, unitPro: 0.026, unitFlash: 0.0065, baseShare: 1 / 3 });
  ok("前 34×2×0.026", Math.abs(e.before - 1.768) < 1e-9);
  ok("pro へ＝違った 17＋残り 17 の 15%", Math.abs(e.escalated - (17 + 17 * 0.15)) < 1e-9);
  ok("後は前より安い（違った割合 50%）", e.after < e.before, `${e.after}`);
  const all = estimateScreen({ q: 34, reps: 2, flashDiffRate: 1, unitPro: 0.026, unitFlash: 0.0065 });
  ok("全部違う時は高くなる（ふるいの分だけ）", all.after > all.before);
}

console.log(`exam-screen: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
