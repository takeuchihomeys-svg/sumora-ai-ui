// app/lib/__tests__/metric-map.test.ts — 数ごとの地図（木）と見込みの突き合わせの純関数（作業員P・2026-11-23・台帳 #610）
//   実行: npx tsx app/lib/__tests__/metric-map.test.ts
import { conductorReachOf, promiseMapTurnsOf, ownerOfLeaf, leafReachOf, closingTurnsOf, ackPlusCheckPromiseOf, sideOf, minorityOf, deviceTurnsOf, deviceCauseOf, routeTurnsOf, routeCauseOf, itemsForRoot, rebaseKey, buildTree, sumMismatches, leavesOf, rankLeaves, forecastVerdictOf, dueChecksOf, fixShareOf, sceneOfWatchKey, examLeafOf, examAixKindOf, examResultsByLeaf, examOrderByMap, gapCauseHintOf, relatedFoundationOf, covers, type MapTurn, type ForecastItem } from "../metric-map";
import { isClosingAix, CLOSE_TEXT_RE, closingVerdictOf, graspGapsOf, closingSummaryOf } from "../closing-chance";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const R = "core:conductor_aix_60d";
const def = { metric: R, label: "AIX の番の一致", dims: ["kind", "scene", "miss", "cause"] as const };

// 実物の形（11/23 60日の数え方: 96番中43一致）を小さくした物
const turns: MapTurn[] = [
  ...Array.from({ length: 6 }, (_, i) => ({ id: i, kind: "estimate_sheet", scene: "cost", miss: "ok" as const, cause: null })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 10 + i, kind: "estimate_sheet", scene: "cost", miss: "reply_not_aix" as const, cause: "aix_turn_as_reply" as const })),
  { id: 20, kind: "estimate_sheet", scene: "cost", miss: "reply_not_aix", cause: "counting" },
  { id: 21, kind: "estimate_sheet", scene: "question", miss: "aix_kind", cause: "misread" },
  ...Array.from({ length: 3 }, (_, i) => ({ id: 30 + i, kind: "property_check_result", scene: "property_share", miss: "reply_not_aix" as const, cause: "material" as const })),
  { id: 40, kind: "property_check_result", scene: "property_share", miss: "ok", cause: null },
];
const nodes = buildTree(turns, { ...def, dims: [...def.dims] });
t("根の n と一致", nodes[0].n === 16 && nodes[0].ok === 7 && nodes[0].misses === 9 && nodes[0].value === 43.8);
t("子を足すと親に戻る（全部の親）", sumMismatches(nodes).length === 0);
t("壊した木は食い違いに出る（根と壊した親の2つ）", sumMismatches(nodes.map((x) => (x.key === `${R}/kind=estimate_sheet` ? { ...x, n: x.n + 1 } : x))).length === 2);
t("一致の葉には原因の子が無い", !nodes.some((x) => x.parent?.endsWith("/miss=ok")));
t("葉の鍵の形", nodes.some((x) => x.key === `${R}/kind=estimate_sheet/scene=cost/miss=reply_not_aix/cause=aix_turn_as_reply` && x.n === 4));
t("葉の数の合計は根と同じ", leavesOf(nodes).reduce((s, l) => s + l.n, 0) === 16);

const it = (o: Partial<ForecastItem>): ForecastItem => ({ id: 1, title: "x", stage: "built_off", owner: "作業員A", priority: 0, switch_name: null, switch_default: null, next_step: "試験を積む", blocker: null, forecast_metric: R, forecast_leaf: R, forecast_writer_select: "style", forecast_before: 44.8, forecast_low: 60, forecast_high: 70, ...o });
t("直る見込み（44.8 → 60〜70 の真ん中 65 は外れの 36.6%）", Math.abs((fixShareOf(it({})) ?? 0) - 0.366) < 0.001);
const ranked = rankLeaves(nodes, [it({}), it({ id: 2, forecast_leaf: `${R}/kind=property_check_result`, forecast_before: 25, forecast_low: 70, forecast_high: 80, stage: "passed" })]);
t("順位1 は外れの多い見積の返信にした葉（物件確認は場面の n 4 で判断保留＝0.3倍）", ranked[0].key.endsWith("kind=estimate_sheet/scene=cost/miss=reply_not_aix/cause=aix_turn_as_reply") && ranked[1].hold);
t("根だけの見込みの葉は穴（見積の返信にした・外れ 4）", ranked.find((r) => r.key.endsWith("kind=estimate_sheet/scene=cost/miss=reply_not_aix/cause=aix_turn_as_reply"))!.hole === true);
t("種類に付いた作業の葉は穴でない・作業 #2 が次の一手", (() => { const p = ranked.find((r) => r.key.includes("property_check_result"))!; return !p.hole && p.items.includes(2) && p.nextStep.startsWith("#2"); })());
t("外れ 2 以下・場面の n<5 は判断保留（0.3倍）", ranked.find((r) => r.key.includes("scene=question"))!.hold === true);
t("書き手の選び方が違う作業は使わない", rankLeaves(nodes, [it({ id: 3, forecast_leaf: `${R}/kind=property_check_result`, forecast_writer_select: "device" })], { writerSelect: "style" }).find((r) => r.key.includes("property_check_result"))!.items.length === 0);

t("幅の中", forecastVerdictOf(60, 70, 63, 40) === "in");
t("下に外れ", forecastVerdictOf(60, 70, 52, 40) === "below");
t("n が小さいと保留", forecastVerdictOf(60, 70, 52, 3) === "pending");
const d0 = Date.parse("2026-11-01T00:00:00Z");
t("7日・14日の頃", JSON.stringify(dueChecksOf(d0, d0 + 15 * 86_400_000, [])) === "[7,14]" && JSON.stringify(dueChecksOf(d0, d0 + 15 * 86_400_000, [7])) === "[14]" && dueChecksOf(d0, d0 + 3 * 86_400_000, []).length === 0);
t("外れの原因の候補（作業の葉の下の一番多い原因）", gapCauseHintOf(nodes, `${R}/kind=property_check_result`) === "material");

t("場面: 返信:条件提示 → conditions", sceneOfWatchKey("返信:条件提示") === "conditions");
t("場面: AIX:estimate_sheet → cost", sceneOfWatchKey("AIX:estimate_sheet") === "cost");
t("場面: 返信:短い了承・お礼 → ack", sceneOfWatchKey("返信:短い了承・お礼") === "ack");
t("試験: AIX:estimate_sheet の問題 → 種類", examAixKindOf({ id: "q1", accept: ["AIX:estimate_sheet"] }) === "estimate_sheet");
t("試験: 左右・返信は当たらない", examAixKindOf({ id: "q2", accept: ["AIX:左右"] }) === null && examAixKindOf({ id: "q3", accept: ["返信"] }) === null);
t("試験: 種類×場面の葉", examLeafOf({ id: "q1", accept: ["AIX:estimate_sheet"] }, R, "返信:質問").leaf === `${R}/kind=estimate_sheet/scene=question`);
const by = examResultsByLeaf([{ problem_id: "q1", leaf_key: `${R}/kind=estimate_sheet/scene=cost` }, { problem_id: "q2", leaf_key: `${R}/kind=estimate_sheet/scene=cost` }], new Map([["q1", true], ["q2", false]]), new Map([["q1", false], ["q2", true]]));
const o = by.get(`${R}/kind=estimate_sheet/scene=cost`)!;
t("試験の結果を葉に戻す（前→後・悪くなった・良くなった）", o.n === 2 && o.before_ok === 1 && o.after_ok === 1 && o.worse[0] === "q1" && o.better[0] === "q2");
t("試験の順番の案: 伸びしろの大きい葉の問題を先に", examOrderByMap(["qa", "qb"], new Map([["qa", `${R}/kind=property_check_result`], ["qb", `${R}/kind=estimate_sheet`]]), ranked)[0] === "qb");
t("関わる土台の空き（同じ場面・all・value 0 だけ）", JSON.stringify(relatedFoundationOf(`${R}/kind=estimate_sheet/scene=cost`, [{ metric: "found:n.chrono:cost:scene_rules", value: 0 }, { metric: "found:n.chrono:viewing:scene_rules", value: 0 }, { metric: "found:n.link:all:rules", value: 0, detail: { cause: "measure" } }, { metric: "found:n.trust:all:parts", value: 0 }, { metric: "found:n.flex:cost:rules", value: 1 }])) === JSON.stringify(["found:n.chrono:cost:scene_rules", "found:n.trust:all:parts"]));
t("covers は段の区切りで", covers(`${R}/kind=a`, `${R}/kind=a/scene=b`) && !covers(`${R}/kind=a`, `${R}/kind=ab`));

// ── 11/23（2回目）端末の版・申込までの地図・根の付け替え ──
{
  const D = "aix_turn:match_60d_device";
  t("根の付け替え", rebaseKey(`${R}/kind=a/scene=b`, R, D) === `${D}/kind=a/scene=b` && rebaseKey("x/kind=a", R, D) === "x/kind=a");
  t("端末の原因: 先後は読み違い・種類違いは mk があれば材料", deviceCauseOf({ id: 1, cls: "two_stage", tk: "property", v: "先後" }) === "misread" && deviceCauseOf({ id: 2, cls: "aix_first", tk: "property", v: "種類違い", mat: { mk: ["estimate_amount"] } }) === "material");
  t("端末の原因: 前の約束の果たしは数え方にしない（11/23 A）・手元に無い物件は材料・あれば判断", deviceCauseOf({ id: 3, cls: "aix_first", tk: "property_check_result", v: "AIXの番を返信", prevFulfil: true, mat: { checked: 1 } }) === "aix_turn_as_reply"
    && deviceCauseOf({ id: 4, cls: "aix_first", tk: "property", v: "AIXの番を返信", mat: { pend: 0, pp: false } }) === "material" && deviceCauseOf({ id: 5, cls: "aix_first", tk: "property", v: "AIXの番を返信", mat: { pend: 3 } }) === "aix_turn_as_reply" && deviceCauseOf({ id: 6, cls: "aix_first", tk: "property", v: "一致" }) === null);
  const dt = deviceTurnsOf([{ id: 1, cls: "aix_first", tk: "property", v: "一致" }, { id: 2, cls: "reply", tk: null, v: "返信一致" }, { id: 3, cls: "two_stage", tk: "estimate_sheet", v: "先後" }], new Map([[1, "返信:了承"], [3, null]]));
  t("端末の番: 返信の番は外す・場面は scene_key・先後は order", dt.length === 2 && dt[0].scene === "ack" && dt[1].miss === "order" && dt[1].scene === "cost");
  const rt = routeTurnsOf([{ conv: "a", at: "1", node: "pickup", branch: null, agree: "promise_match", dir: "promise" }, { conv: "a", at: "2", node: "pickup", branch: null, agree: "push_missed", dir: "promise" }, { conv: "b", at: "3", node: "hearing", branch: "viewing_lapsed", agree: "pushed_off_map", dir: "forward", nextAix: [] }]);
  const rtree = buildTree(rt, { metric: "route:next_match_60d", label: "r", dims: ["station", "miss", "cause"] });
  t("申込までの地図: 駅 → 外れの型 → 原因・子の合計が戻る", rt[0].miss === "ok" && rt[1].cause === "counting" && rt[2].station === "分:viewing_lapsed" && rt[2].cause === "material" && sumMismatches(rtree).length === 0 && rtree[0].n === 3 && rtree[0].misses === 2);
  t("申込までの地図の原因: other_aix は状態の食い違いで材料", routeCauseOf({ conv: "c", at: "4", node: "x", branch: null, agree: "other_aix", dir: null, subAt1: false }) === "material");
  const base = { title: "", stage: "testing", owner: null, priority: 1, switch_name: null, switch_default: null, next_step: null, blocker: null, forecast_writer_select: "device", forecast_before: 54.9, forecast_low: 66.7, forecast_high: 73.5 };
  const its = itemsForRoot([{ ...base, id: 627, forecast_metric: D, forecast_leaf: D, forecast_exam: { parts: [{ leaf: `${R}/kind=property/scene=ack`, fixes: 8 }] } }, { ...base, id: 612, forecast_metric: R, forecast_leaf: `${R}/kind=property` }, { ...base, id: 9, forecast_metric: "other", forecast_leaf: "other" }] as Array<ForecastItem & { forecast_exam?: unknown }>, { metric: D, rebaseFrom: [R] });
  t("根の作業: 部品は葉ごとの作業（fixes）・別の根の葉は付け替え・関係ない作業は外す", its.length === 2 && its[0].forecast_leaf === `${D}/kind=property/scene=ack` && its[0].fixes === 8 && its[1].forecast_leaf === `${D}/kind=property`);
  const dtree = buildTree(Array.from({ length: 10 }, (_, i) => ({ id: i, kind: "property", scene: "ack", miss: "reply_not_aix" as const, cause: "material" as const })), { metric: D, label: "d", dims: ["kind", "scene", "miss", "cause"] });
  const rk = rankLeaves(dtree, its);
  t("部品の直る見込み＝fixes ÷ 部品の葉の外れ", rk[0].fixShare === 0.8 && rk[0].items.includes(627));
}

// ── 11/23（3回目）竹内さんの少数側 ──
{
  const mk = (id: number, move: string, brain: string, isMiss = false, shape = "ack|約束:なし|thanks") => ({ id, shapes: [shape, "ack|約束:なし"], move, brain, isMiss });
  const rows = [...Array.from({ length: 9 }, (_, i) => mk(i, "reply_first", "reply_first")), mk(100, "aix:greeting_viewing", "reply_first", true), mk(101, "aix:property", "aix:greeting_viewing", true)];
  const m = minorityOf(rows);
  t("少数側: 過半数の一手をブレインが選んだ外れだけ（n 10 以上）", m.has(100) && !m.has(101) && m.get(100)!.majority === "reply_first" && m.get(100)!.n === 11);
  t("少数側: n が 10 に届かない形は数えない", minorityOf(rows.slice(0, 8).concat([mk(100, "aix:x", "reply_first", true)])).size === 0);
  const half = [...Array.from({ length: 5 }, (_, i) => mk(i, "reply_first", "reply_first")), ...Array.from({ length: 5 }, (_, i) => mk(10 + i, "aix:a", "aix:a")), mk(99, "aix:a", "reply_first", true)];
  t("少数側: 過半数（半分より多い）が無い形は数えない", !minorityOf(half.slice(0, 10).concat([mk(99, "aix:b", "reply_first", true)])).has(99));
}

// ── 11/23（4回目）名前の付いた形・時刻で送る物 ──
{
  const nm = (id: number, move: string, brain: string, isMiss = false) => ({ id, shapes: [`s${id}`], namedShapes: ["前24時間にお客様が物件を送ってきた"], move, brain, isMiss });
  const rows = [...Array.from({ length: 9 }, (_, i) => nm(i, "aix:property_check_result", "aix:property_check_result")), { ...nm(50, "aix:estimate_sheet", "aix:property_check_result", true), kindOnly: true }];
  t("名前の付いた形: 細かい形で n が足りない時も同じ線で少数側", minorityOf(rows).has(50) && minorityOf(rows).get(50)!.shape.startsWith("前24時間"));
  const tt = deviceTurnsOf([{ id: 7444, cls: "hand_aix", tk: "greeting_viewing", v: "AIXの番を返信" }, { id: 7445, cls: "aix_first", tk: "greeting_viewing", v: "一致" }], new Map());
  t("時刻で送る物: 当日のご挨拶の外れは timed（一致はそのまま）", tt[0].miss === "timed" && tt[0].cause === null && tt[1].miss === "ok");
  const tree = buildTree(tt, { metric: "d", label: "d", dims: ["kind", "scene", "miss", "cause"] });
  t("時刻で送る物は順位に入れない", rankLeaves(tree, []).length === 0);
}

// ── 11/23（5回目）割れ・n 不足 ──
{
  const mk = (id: number, move: string, brain: string, isMiss = false) => ({ id, shapes: ["ack|約束:property_check_result|other"], move, brain, isMiss });
  const split = [...Array.from({ length: 4 }, (_, i) => mk(i, "aix:property_check_result", "aix:property_check_result")), ...Array.from({ length: 4 }, (_, i) => mk(10 + i, "reply_first", "reply_first")), mk(20, "aix:property", "aix:property"), mk(99, "aix:property_check_result", "reply_first", true)];
  const s = sideOf(split);
  t("割れ: 過半数が無く上位2つで8割以上・ブレインはその片方", s.get(99)?.side === "split");
  const short = Array.from({ length: 6 }, (_, i) => mk(i, "reply_first", "reply_first")).concat([mk(99, "aix:x", "reply_first", true)]);
  t("n 不足: どの形も 10 に届かない（5 以上）→ 印だけ", sideOf(short).get(99)?.side === "n_short" && minorityOf(short).size === 0);
}

// ── 11/23（6回目）名前の付いた形「確認の約束が開いている×お客様が了承に少し足した」 ──
t("確認の約束×了承に少し足した: 5つを全部満たす時だけ", ackPlusCheckPromiseOf("ありがとうございます、土曜なら午後も動けます", ["property_check_result"])
  && !ackPlusCheckPromiseOf("ありがとうございます", ["property_check_result"]) && !ackPlusCheckPromiseOf("ありがとうございます、何時ごろになりますか", ["property_check_result"])
  && !ackPlusCheckPromiseOf("ありがとうございます、土曜なら午後も動けます", ["property"]));

// ── 11/23 #658 決めに行く番 ──
{
  t("決めに行く AIX: 申込の後押しと審査の相談の電話だけ（確定・申込書は入れない）", isClosingAix("application_push/push") && isClosingAix("application_push") && !isClosingAix("application_push/format") && !isClosingAix("application_push/confirm") && isClosingAix("phone_call", "審査って通りますか") && !isClosingAix("phone_call", "電話できますか"));
  t("手打ちの決めに行く文", CLOSE_TEXT_RE.test("先にお申込みでお部屋を抑えて頂けますと安心です") && CLOSE_TEXT_RE.test("審査に出してみませんか") && !CLOSE_TEXT_RE.test("申込書をお送りします"));
  t("見逃し・早すぎ", closingVerdictOf(true, false) === "missed" && closingVerdictOf(false, true) === "early" && closingVerdictOf(true, true) === "both");
  t("統括の材料の欠け", JSON.stringify(graspGapsOf({ emo: "前向き", sig: null, timeline: "", prop: "A", concern: null, cp: "viewing", op: "x", intent: "decision" })) === JSON.stringify(["sig", "timeline", "concern"]));
  const rows = [
    { id: 1, takeuchiClose: true, brainClose: true, closeHow: "aix:application_push/push", brainAct: "application_push/push", level: "hot", gaps: [], verdict: "both" as const, applied14: true, conv: "a", at: "x", readiness: 60 },
    { id: 2, takeuchiClose: true, brainClose: false, closeHow: "hand", brainAct: "auto_reply", level: "warm", gaps: ["sig"], verdict: "missed" as const, applied14: false, conv: "a", at: "x", readiness: 35 },
    { id: 3, takeuchiClose: false, brainClose: true, closeHow: null, brainAct: "application_push", level: "cold", gaps: [], verdict: "early" as const, applied14: null, conv: "b", at: "x", readiness: 10 },
  ];
  const s = closingSummaryOf(rows);
  t("決めに行く番の数え（主＝竹内さんが決めに行った番でブレインも）", s.closeRate === 50 && s.brainPrecision === 50 && s.missed === 1 && s.early === 1 && s.afterTakeuchiClose.applied === 1 && s.gapCount.sig === 1);
  const ct = closingTurnsOf(rows, "closing"), ce = closingTurnsOf(rows, "closing_early");
  t("決めに行く番の木の番", ct.length === 2 && ct[1].miss === "close_missed" && ct[1].cause === "material" && ce.length === 2 && ce[1].miss === "close_early" && ce[1].cause === "misread");
}

// ── 11/23 N2 の頼み: 葉の持ち主・統括に届いているか ──
{
  const D = "aix_turn:match_60d_device";
  t("葉の持ち主の案", ownerOfLeaf(`${D}/kind=zenryoku_support/scene=question`, "作業員A").owner === "作業員N2" && ownerOfLeaf(`${D}/kind=property/scene=property_send`, "作業員A").owner === "作業員L" && ownerOfLeaf(`${D}/kind=meeting_place`, "作業員A").why === "根の持ち主");
  t("統括に届いているか", leafReachOf(`${D}/kind=property/scene=ack`, []) === "未確認" && leafReachOf(`${D}/kind=property/scene=ack`, [`${R}/kind=property/scene=ack`], [R]) === "届いている" && leafReachOf(`${D}/kind=property/scene=ack`, [`${R}/kind=estimate_sheet`], [R]) === "届いていない");
}

// ── 11/23 統括に届いているか（学び・材料の2つの道）・約束の地図 ──
{
  const D = "aix_turn:match_60d_device";
  const lk = { cut: new Set(["read.staff_hand"]), off: new Set<string>(), at: "x" };
  t("届いているか: 学びの道", conductorReachOf(`${D}/kind=property/scene=ack`, [`${R}/kind=property`], [R], lk).via === "学び");
  t("届いているか: 材料の道（全部つながっていれば届いている・切れがあれば届いていない）", conductorReachOf(`${D}/kind=estimate_sheet/scene=cost`, [], [R], lk).via === "材料"
    && conductorReachOf(`${D}/kind=property/scene=question`, [], [R], lk).reach === "届いていない" && conductorReachOf(`${D}/kind=property/scene=question`, [], [R], lk).cutRows.includes("read.staff_hand")
    && conductorReachOf(`${D}/kind=meeting_place`, [], [R], null).reach === "未確認");
  const pm = promiseMapTurnsOf({ root: "promise:kept_true", turns: [{ id: 1, kind: "pickup", scene: "ack", miss: "ok" }, { id: 2, kind: "check", scene: "question", miss: "overdue", cause: "judgment" }] });
  t("約束の地図の番", pm.length === 2 && pm[0].cause === null && pm[1].miss === "overdue" && pm[1].cause === "judgment");
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
