// 試験の決め直し・振り返り（scripts/lib/exam-reflection.ts）の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-reflection.test.ts（全 PASS で exit 0）
import { reflectRun, reflectionLine, targetsUnchanged, replanSuggest, replanLine, weeklyRowOf, summarizeWeek, weeklyMarkdown, nothingUsdOf, parseUsd, type ReflRow, type ReplanCard } from "../exam-reflection";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const row = (id: string, rep: number, p: boolean, code = "返信", ess?: boolean): ReflRow => ({ id, rep, score: { pass: p }, path: { code, ok: p }, ...(ess == null ? {} : { essence: { ok: ess } }) });

// ─── ⑦ 振り返り ───
{
  const rows = [row("q1", 1, true), row("q1", 2, true), row("q2", 1, false), row("q3", 1, true, "返信"), row("q3", 2, true, "AIX:x"), row("q4", 1, true), row("g1", 1, true), row("g2", 1, true)];
  const r = reflectRun({ ids: ["q1", "q2", "q3", "q4", "g1", "g2"], guards: ["g1", "g2"], rows, result: { pathWorse: [{ id: "g2" }], essenceWorse: [], worseSure: [], worseFlake: [] } });
  const k = (id: string) => [...r.found, ...r.nothing].find((f) => f.id === id)!;
  ok("振り返り: 全部で6問・狙い4・守り2", r.selected === 6 && r.targets === 4 && r.guards === 2);
  ok("振り返り: 毎回合格・道も同じは何も見つけない", k("q1").kinds.length === 0 && r.nothing.some((f) => f.id === "q1"));
  ok("振り返り: 不合格は外れ", k("q2").kinds.includes("miss"));
  ok("振り返り: 回で道が割れたら揺れ", k("q3").kinds.includes("flake") && !k("q3").kinds.includes("miss"));
  ok("振り返り: 守りの道の悪化を守りとして数える", k("g2").role === "guard" && k("g2").kinds.includes("path"));
  ok("振り返り: 回の数を残す", r.reps.q1 === 2 && r.reps.q2 === 1);
  const line = reflectionLine(r);
  ok("1行: 見つけた数と守り", line.includes("見つけた 3/6問") && line.includes("守り 1/2問が見つけた"), line);
}
{
  // rows が無い（古い結果）: missStages の n と reps で外れと揺れ
  const r = reflectRun({ ids: ["a", "b", "c"], result: { reps: { a: 4, b: 1, c: 2 }, missStages: [{ id: "a", n: 2 }, { id: "b", n: 1 }], worseSure: [{ id: "c", why: "2/2→1/2" }] } });
  const k = (id: string) => [...r.found, ...r.nothing].find((f) => f.id === id)!;
  ok("古い結果: 4回中2回外れ＝外れ＋揺れ", k("a").kinds.includes("miss") && k("a").kinds.includes("flake"));
  ok("古い結果: 1回中1回外れ＝外れだけ", k("b").kinds.join() === "miss");
  ok("古い結果: 合格の悪化", k("c").kinds.join() === "worse");
}
ok("1行: 問題0なら空", reflectionLine(reflectRun({ ids: [], result: {} })) === "");

// ─── ⑥ 効いたか ───
{
  const base = [row("q1", 1, false, "返信", false), row("q2", 1, true, "返信", true)];
  ok("効かず: 合格も本質も同じ", targetsUnchanged([row("q1", 1, false, "返信", false), row("q1", 2, false, "返信", false), row("q2", 1, true, "返信", true)], base, ["q1", "q2"]).unchanged);
  const c = targetsUnchanged([row("q1", 1, true, "返信", false), row("q2", 1, true, "返信", true)], base, ["q1", "q2"]);
  ok("効いた: 合格が変われば効かずではない", !c.unchanged && c.changed.join() === "q1");
  ok("効いた: 本質だけ変わっても効かずではない", !targetsUnchanged([row("q1", 1, false, "返信", true), row("q2", 1, true, "返信", true)], base, ["q1", "q2"]).unchanged);
  const n = targetsUnchanged([row("q9", 1, true)], base, ["q9"]);
  ok("比べた狙いが無ければ判断しない", !n.unchanged && n.compared === 0);
}

// ─── ⑥ 決め直しの案 ───
{
  const e = (x: number, y: number) => [x, y];
  const cards: ReplanCard[] = [
    { id: "t1", type: "内覧", stage: "brain", embedding: e(1, 0) },
    { id: "s1", type: "内覧", stage: "brain", embedding: e(0, 1) },  // 同じ場面・遠い
    { id: "s2", type: "内覧", stage: "brain", embedding: e(0.9, 0.1) }, // 同じ場面・近い
    { id: "o1", type: "見積", stage: "brain", embedding: e(0.99, 0.01) }, // 別の場面・とても近い
    { id: "o2", type: "見積", stage: "brain", embedding: e(0, 1) },   // 別の場面・遠い＝候補外
    { id: "g1", type: "内覧", stage: "brain", embedding: e(1, 0) },   // 依頼に入っている守り
  ];
  const v = { unchanged: true, compared: 1, worseN: 0, pathN: 0, essenceN: 0 };
  const p = replanSuggest({ targets: ["t1"], jobIds: ["t1", "g1"], switchName: "SW_X", label: "lbl", owner: "作業員8c", cards, nightlyIds: new Set(["s1"]), verdict: v });
  ok("案: 出る", !!p);
  const ids = p!.add.map((a) => a.id);
  ok("案: 依頼に入っている問題は出さない", !ids.includes("t1") && !ids.includes("g1"));
  ok("案: 同じ場面が先（夜の基準ありの s1 → 近い s2）・次に近い別の場面", ids.join() === "s1,s2,o1", ids.join());
  ok("案: 遠い別の場面は出さない", !ids.includes("o2"));
  ok("案: 3問まで", replanSuggest({ targets: ["t1"], jobIds: ["t1"], cards, verdict: v, max: 9 })!.add.length === 3);
  ok("案: 積むコマンドは --repeat=1 で名指し", !!p!.cmd && p!.cmd.includes("--only=s1,s2,o1") && p!.cmd.includes("--switch=SW_X") && p!.cmd.includes("--label=lbl-rp"));
  ok("案: 重点に場面とスイッチ", p!.focus.switch === "SW_X" && p!.focus.scenes.join() === "内覧");
  ok("案の1行: 流さないと書く", replanLine(p).includes("流さない") && replanLine(null) === "");
  ok("案: 同じスイッチで外れを見つけた問題は同じ場面と同じ重さ", replanSuggest({ targets: ["t1"], jobIds: ["t1"], cards, verdict: v, hitIds: new Set(["o2"]), max: 1, nightlyIds: new Set(["o2"]) })!.add[0].id === "o2");
  ok("案: 効いた時は出さない", replanSuggest({ targets: ["t1"], jobIds: ["t1"], cards, verdict: { ...v, unchanged: false } }) === null);
  ok("案: 合格の悪化があれば出さない", replanSuggest({ targets: ["t1"], jobIds: ["t1"], cards, verdict: { ...v, worseN: 1 } }) === null);
  ok("案: 道の悪化があれば出さない", replanSuggest({ targets: ["t1"], jobIds: ["t1"], cards, verdict: { ...v, pathN: 1 } }) === null);
  ok("案: 本質の悪化があれば出さない", replanSuggest({ targets: ["t1"], jobIds: ["t1"], cards, verdict: { ...v, essenceN: 1 } }) === null);
  ok("案: 比べた狙い0なら出さない", replanSuggest({ targets: ["t1"], jobIds: ["t1"], cards, verdict: { ...v, compared: 0 } }) === null);
  ok("案: 下書きの段の依頼は下書きの札だけ", replanSuggest({ targets: ["t1"], jobIds: ["t1"], cards, verdict: v, stage: "draft" }) === null);
}

// ─── 週の集計 ───
{
  ok("費用: $0.177 を読む", parseUsd("$0.177") === 0.177 && parseUsd(null) === null && parseUsd("?") === null);
  const r1 = weeklyRowOf({ label: "a", owner: "作業員1", only: "q1,q2,g1", reps: { q1: 3, q2: 1, g1: 1 }, usd: "$0.50", at: "2026-11-05T00:00:00Z", missStages: [{ id: "q2", n: 1 }] }, (l) => (l === "a" ? ["g1"] : null));
  ok("週: 古い結果を作り直す", !!r1 && r1.rebuilt && r1.reflection.guards === 1 && r1.reflection.nothing.length === 2);
  ok("週: 何も見つけなかった分の費用は回で割り振る（q1 3回＋g1 1回 / 5回）", Math.abs(nothingUsdOf(r1!) - 0.4) < 1e-9, String(nothingUsdOf(r1!)));
  ok("週: tsc の結果は数えない", weeklyRowOf({ label: "t", runner: "tsc-remote", only: "" }) === null);
  const refl = reflectRun({ ids: ["q1", "g2"], guards: ["g2"], result: { pathWorse: [{ id: "g2" }] } });
  const r2 = weeklyRowOf({ label: "b", owner: "作業員8c", usd: "$0.10", at: "2026-11-06T00:00:00Z", reflection: refl, replan: { v: 1, why: "", focus: { switch: "", scenes: [] }, add: [], cmd: null } });
  ok("週: 記録のある結果はそのまま", !!r2 && !r2.rebuilt && r2.replan);
  const r3 = weeklyRowOf({ label: "c", owner: "作業員1", only: "q1", usd: "$0.05", at: "2026-11-07T00:00:00Z" });
  const s = summarizeWeek([r1!, r2!, r3!], { from: "2026-11-03T15:00:00Z", to: "2026-11-10T15:00:00Z" });
  ok("週: 問題 6・何も見つけなかった 4", s.problems === 6 && s.nothing === 4, JSON.stringify(s));
  ok("週: 守り 2問足して1問見つけた（道の悪化）", s.guards.added === 2 && s.guards.found === 1 && s.guards.kinds.path === 1 && s.guards.ids.join() === "g2");
  ok("週: 作業員ごと（費用の多い順）", s.byOwner[0].owner === "作業員1" && s.byOwner[0].jobs === 2 && s.byOwner[1].owner === "作業員8c");
  ok("週: q1 は3回選んで何も見つけない", s.idleIds[0]?.id === "q1" && s.idleIds[0].times === 3);
  ok("週: 案の数・作り直しの数", s.replans === 1 && s.rebuilt === 2);
  const md = weeklyMarkdown(s);
  ok("週: 1行目に割合と費用と守り", md.includes("何も見つけなかった 4問（67%）") && md.includes("守り 1/2問が見つけた") && md.includes("| 作業員1 |"), md);
  ok("週: missStages の無い古い結果は外れを数えられない印", s.missUnknown === 1 && md.includes("外れを数えられない"), String(s.missUnknown));
  ok("週: 空でも落ちない", weeklyMarkdown(summarizeWeek([], { from: "x", to: "y" })).includes("依頼 0本"));
}

console.log(`exam-reflection: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
