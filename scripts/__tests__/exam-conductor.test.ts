// scripts/__tests__/exam-conductor.test.ts — 試験の統括の純関数（関所の時間・早めの打ち切り・揺れの回数・問題の選び・表への書き戻し）
//   実行: npx tsx scripts/__tests__/exam-conductor.test.ts
import { hazardAuditDue, splitWorse, isMixedRow, jobSize, compareJobs, splitIds, splitByTime, estimateJobMin, cleanupTargets, remoteDeployState, inspectOutputText, remainingIds, comparedIds, staleExamGuard, cheapNow, maxExamsNow, earlyVerdict, repsPlan, pickProblems, updateReleaseOrder, spreadPick } from "../lib/exam-conductor-core";
import type { FlakeObs } from "../lib/exam-flake";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const jst = (iso: string) => new Date(Date.parse(iso) - 9 * 3600_000); // JST の時刻 → Date
t("平日 11:00 は混雑", !cheapNow(jst("2026-11-04T11:00:00Z")));
t("平日 13:30 は安い", cheapNow(jst("2026-11-04T13:30:00Z")));
t("平日 16:00 は混雑", !cheapNow(jst("2026-11-04T16:00:00Z")));
t("平日 20:00 は安い", cheapNow(jst("2026-11-04T20:00:00Z")));
t("土曜 11:00 は安い", cheapNow(jst("2026-11-07T11:00:00Z")));
t("営業時間は1本", maxExamsNow(jst("2026-11-04T20:00:00Z")) === 1);
t("夜は2本", maxExamsNow(jst("2026-11-04T23:00:00Z")) === 2 && maxExamsNow(jst("2026-11-05T03:00:00Z")) === 2);

// ① 早めの打ち切り
const R = (id: string, rep: number, ok: boolean) => ({ id, rep, score: { pass: ok } });
const base = [R("q1", 1, true), R("q1", 2, true), R("q2", 1, false), R("q2", 2, false), R("q3", 1, true), R("q3", 2, true)];
const plan2 = { q1: 2, q2: 2, q3: 2 };
t("前に合格の問題が2回中1回落ちた＝悪化の確定で止める", earlyVerdict([R("q1", 1, false)], base, plan2).stop === "worse");
t("前に不合格の問題が落ちても止めない", earlyVerdict([R("q2", 1, false)], base, plan2).stop === null);
t("4回の揺れる問題は1回落ちただけでは止めない", earlyVerdict([R("q1", 1, false)], base, { ...plan2, q1: 4 }).stop === null);
t("4回の揺れる問題が2回落ちたら止める", earlyVerdict([R("q1", 1, false), R("q1", 2, false)], base, { ...plan2, q1: 4 }).stop === "worse");
t("揺れる問題: main が全部合格でも2回落ちた（2回の差）は止める", earlyVerdict([R("q1", 1, false), R("q1", 2, false)], base, { ...plan2, q1: 4 }, new Set(["q1"])).stop === "worse");
const b4 = [R("q1", 1, true), R("q1", 2, true), R("q1", 3, true), R("q1", 4, false)];
t("揺れる問題: main 3/4 で今2回落ちた（1回の差）は止めない", earlyVerdict([R("q1", 1, false), R("q1", 2, false)], b4, { q1: 4 }, new Set(["q1"])).stop !== "worse");
t("揺れる問題: main より2回以上多く落ちたら止める", earlyVerdict([R("q1", 1, false), R("q1", 2, false), R("q1", 3, false)], b4, { q1: 4 }, new Set(["q1"])).stop === "worse");
t("結果: 揺れる問題の1回の差は揺れの範囲", (() => { const w = splitWorse([R("q1", 1, true), R("q1", 2, true), R("q1", 3, false), R("q1", 4, false)], b4, new Set(["q1"])); return w.flake.length === 1 && w.sure.length === 0; })());
t("結果: 普通の問題は確かな悪化", (() => { const w = splitWorse([R("q3", 1, false), R("q3", 2, true)], base, new Set()); return w.sure.length === 1 && w.sure[0].id === "q3"; })());
t("結果: 揺れる問題でも2回以上の差は確か", splitWorse([R("q1", 1, false), R("q1", 2, false), R("q1", 3, false), R("q1", 4, true)], b4, new Set(["q1"])).sure.length === 1);
t("途中は止めない", earlyVerdict([R("q1", 1, true), R("q1", 2, true), R("q2", 1, true)], base, plan2).stop === null);
t("全部の合否が決まったら止める（settled）", earlyVerdict([R("q1", 1, true), R("q1", 2, true), R("q2", 1, false), R("q3", 1, true), R("q3", 2, true)], base, plan2).stop === "settled");
t("前に無い問題は悪化にしない", earlyVerdict([R("q9", 1, false)], base, { q9: 2, q1: 2 }).stop === null);
t("エラーの行は数えない", earlyVerdict([{ id: "q1", rep: 1, error: "x" }], base, plan2).stop === null);

// ③ 揺れの回数
const O = (id: string, sig: string, at: string, codeKey = "k1"): FlakeObs => ({ id, problemHash: "h", model: "deepseek-v", codeKey, label: "l", rep: 1, at, sig, pathSig: sig, independent: true });
const obs: Record<string, FlakeObs[]> = { qa: [O("qa", "A|○", "2026-11-01T00:00:00Z"), O("qa", "B|✕", "2026-11-01T01:00:00Z")], qb: [O("qb", "A|○", "2026-11-01T00:00:00Z")] };
const rp = repsPlan(["qa", "qb", "qc"], (id) => obs[id] ?? [], { normal: 2, flakyReps: 4, forced: ["qc"], model: "deepseek" });
t("同じコードで割れた問題は4回", rp.reps.qa === 4);
t("割れていない問題は2回", rp.reps.qb === 2);
t("名指しの揺れる問題は4回", rp.reps.qc === 4 && rp.flaky.length === 2);
// 2026-11-05 id のぶつかり（作業員4）: 別の中身の問題（hash h）の揺れの記録で回数を決めない
t("中身の hash の候補に当たらない観測は使わない（qa は h の観測だけ＝別の中身なら2回）", repsPlan(["qa"], (id) => obs[id] ?? [], { normal: 2, flakyReps: 4, model: "deepseek", hashesOf: () => ["other"] }).reps.qa === 2);
t("候補に当たれば今まで通り（qa は4回）", repsPlan(["qa"], (id) => obs[id] ?? [], { normal: 2, flakyReps: 4, model: "deepseek", hashesOf: () => ["x", "h"] }).reps.qa === 4);
t("揺れの回数は3〜6に収める", repsPlan(["qc"], () => [], { normal: 2, flakyReps: 9, forced: ["qc"] }).reps.qc === 6);
const st = [O("qs", "A|○", "2026-11-01T00:00:00Z", "k1"), O("qs", "A|○", "2026-11-01T01:00:00Z", "k2"), O("qs", "A|○", "2026-11-01T02:00:00Z", "k3")];
t("安定（独立に3回同じ答え）は stableReps 回・分からないは normal", (() => { const r = repsPlan(["qs", "qb"], (id) => (id === "qs" ? st : obs[id] ?? []), { normal: 2, flakyReps: 4, stableReps: 1 }); return r.reps.qs === 1 && r.reps.qb === 2 && r.stable?.join() === "qs"; })());
t("stableReps を渡さなければ今まで通り normal", repsPlan(["qs"], () => st, { normal: 2, flakyReps: 4 }).reps.qs === 2);

// ④ 問題の選び
const spec = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, type: i < 6 ? "AIXの種類" : "初回" }));
t("散らして選ぶ", JSON.stringify(spreadPick([0, 1, 2, 3, 4, 5], 3)) === "[0,2,4]");
const pt = pickProblems("types:AIXの種類,初回@2", spec, { only: ["q9"] });
t("型ごとに N 問＋--only", pt.ids.join(",") === "q9,q0,q3,q6,q8");
let threw = false; try { pickProblems("types:無い型", spec, {}); } catch { threw = true; }
t("無い型は止める", threw);
t("正解の組", pickProblems("gold", spec, { golds: ["q1", "q2"] }).ids.join(",") === "q1,q2");
const pm = pickProblems("map", spec, { map: { SW: { types: ["初回"], perType: 1, only: ["q0"], repeat: 3 } }, switchName: "SW" });
t("場面の地図（only＋型・回数）", pm.ids.join(",") === "q0,q6" && pm.repeat === 3);
threw = false; try { pickProblems("map", spec, { map: {}, switchName: "X" }); } catch { threw = true; }
t("複数のスイッチは地図の項目を足し合わせる", (() => { const r = pickProblems("map", spec, { map: { A: { types: ["初回"], perType: 1 }, B: { only: ["q1"], repeat: 3 } }, switchName: "A,B" }); return r.ids.join(",") === "q1,q6" && r.repeat === 3; })());
t("地図に無いスイッチは止める", threw);
t("rag は brain-exam に任せる", pickProblems("rag", spec, {}).selectRag);

// ② 入れる順番の表
const md = "# 表\r\n\r\n| 順 | スイッチ | 担当 | 状態 |\r\n|---|---|---|---|\r\n| 1 | BRAIN_MATERIAL_SELF_REPORT（記録だけ） | 作業員1 | 試験待ち |\r\n| 2 | AIX_DESK_COMMAND=shadow | 作業員1 | 口の接続待ち |\r\n\r\n後ろの文";
const u = updateReleaseOrder(md, "BRAIN_MATERIAL_SELF_REPORT", "試験 ms-on1: 悪化0 | 合格 3→3");
t("スイッチの行の状態だけ置き換える", u.changed && u.md.includes("| 1 | BRAIN_MATERIAL_SELF_REPORT（記録だけ） | 作業員1 | 試験 ms-on1: 悪化0 ／ 合格 3→3 |") && u.md.includes("口の接続待ち") && u.md.endsWith("後ろの文"));
t("改行の形（CRLF）を保つ", u.md.split("\r\n").length === md.split("\r\n").length);
t("スイッチが複数（,）ならどれかの名の行", updateReleaseOrder(md, "X_ONE,AIX_DESK_COMMAND", "y").md.includes("| 2 | AIX_DESK_COMMAND=shadow | 作業員1 | y |"));
t("行が無ければ変えない", !updateReleaseOrder(md, "NO_SUCH", "x").changed);

{ // 2026-11-04 混ざりの回は悪化とも合格とも数えない
  const base = [{ id: "qa", rep: 1, score: { pass: true } }, { id: "qa", rep: 2, score: { pass: true } }];
  const cur = [{ id: "qa", rep: 1, score: { pass: false }, foreignMsgs: 2 }, { id: "qa", rep: 2, score: { pass: false }, pcMismatch: ["家賃"] }];
  t("混ざりの印（他の問題の発言・条件の違い）の回は splitWorse の悪化に入らない", splitWorse(cur, base, new Set()).sure.length === 0);
  t("混ざりの回は earlyVerdict の悪化の確定にもならない", earlyVerdict(cur, base, { qa: 2 }).stop !== "worse");
  t("pcMismatch が「他の問題の発言」だけなら混ざりと見ない・foreignMsgs 0 も", !isMixedRow({ id: "x", rep: 1, pcMismatch: ["他の問題の発言"] }) && !isMixedRow({ id: "x", rep: 1, foreignMsgs: 0 }) && isMixedRow({ id: "x", rep: 1, foreignMsgs: 1 }));
  t("混ざりでない回の悪化は今まで通り", splitWorse([{ id: "qa", rep: 1, score: { pass: false } }, { id: "qa", rep: 2, score: { pass: false } }], base, new Set()).sure.length === 1); }
{ // 2026-11-04 (a)(b)(c) 詰まりの直し
  const now = Date.parse("2026-11-04T12:00:00Z");
  const big = { runner: "brain-exam", only: Array.from({ length: 25 }, (_, k) => "q" + k).join(","), repeat: 2, createdAt: "2026-11-04T11:00:00Z" };
  const small = { runner: "brain-exam", only: "q1,q2,q3", repeat: 1, createdAt: "2026-11-04T11:30:00Z" };
  t("(a) 小さい依頼（問題数×回数）が先・後から入っても", compareJobs(small, big, now) < 0 && jobSize(big) === 50 && jobSize(small) === 3);
  t("(a) 4時間以上待った大きい依頼は大きさを見ない（先に入った順）", compareJobs({ ...big, createdAt: "2026-11-04T07:00:00Z" }, small, now) < 0);
  t("(a) priority が小さい方が先", compareJobs({ ...big, priority: 1 }, small, now) < 0);
  t("(c) 12問ずつに分ける", JSON.stringify(splitIds(Array.from({ length: 25 }, (_, k) => "q" + k)).map((x) => x.length)) === "[12,12,1]" && splitIds(["q1"]).length === 1);
  t("(b) 時間の上限で止めた時の残り＝予定の回数に届いていない問題", JSON.stringify(remainingIds({ q1: 2, q2: 2, q3: 1 }, [{ id: "q1", rep: 1 }, { id: "q1", rep: 2 }, { id: "q2", rep: 1 }, { id: "q3", rep: 1, error: "x" }])) === JSON.stringify(["q2", "q3"])); }
{ const g1 = staleExamGuard("const stopAsked = () => 1; if (stopAsked()) {} acquire({ skip: LANES.map(x=>x) })", 0, 40, 120);
  t("(b) 止める印を見る brain-exam は上限そのまま・古さの印なし", g1.maxMin === 40 && !g1.oldStop && !g1.laneOld && g1.note === "");
  const g2 = staleExamGuard("const STOP_FILE = ''", 5, 40, 120);
  t("(b) 古い brain-exam は上限を延ばし・何個古いかを出す", g2.maxMin === 120 && g2.oldStop && /上限を延ばした 40→120分/.test(g2.note) && /5個古い/.test(g2.note));
  const g3 = staleExamGuard("const stopAsked = () => 1; stopAsked(); x({ skip: LANES })", 3, 90, 120);
  t("(b) 新しい brain-exam でも origin/main より古ければ印だけ出す", g3.maxMin === 90 && /3個古い/.test(g3.note));
  { const g4 = staleExamGuard("const stopAsked = () => 1; stopAsked()", 0, 40, 120);
    t("(i) レーンの直しが無い brain-exam は1レーン（上限はそのまま）", g4.laneOld && g4.maxMin === 40 && /1レーンで回す/.test(g4.note)); }
  t("(i) 古い brain-exam（止める印もレーンも無い）は両方の印", (() => { const g = staleExamGuard("x", 2, 40, 120); return g.laneOld && g.oldStop && /1レーン/.test(g.note) && /延ばした/.test(g.note); })());
  t("(b) 上限なし（0）は延ばさない", staleExamGuard("", null, 0, 120).maxMin === 0); }
{ // 2026-11-05 時間の見積もりで分ける（11/04 夜の grpb-rest: 25問・揺れる22問×4回・古い作業ツリー1レーン＝約232分）
  const ids = Array.from({ length: 25 }, (_, k) => "q" + String(k + 1).padStart(3, "0"));
  const reps: Record<string, number> = Object.fromEntries(ids.map((id, k) => [id, k < 22 ? 4 : 2]));
  const est = estimateJobMin(ids, reps, { lanes: 1 });
  t("見積もり: grpb-rest の形は1レーンで約3時間超", est > 180);
  const ps = splitByTime(ids, reps, { lanes: 1, maxMin: 120 });
  t("1レーン・上限120分: 1本ずつ70分以内に分ける・全部の問題が1回ずつ", ps.length >= 3 && ps.every((x) => estimateJobMin(x, reps, { lanes: 1 }) <= 70) && ps.flat().sort().join() === [...ids].sort().join());
  const p4 = splitByTime(ids, reps, { lanes: 3, maxMin: 40 });
  t("3レーン・上限40分: 1本ずつ32分以内", p4.every((x) => estimateJobMin(x, reps, { lanes: 3 }) <= 32) && p4.flat().length === 25);
  const small = splitByTime(["q1", "q2", "q3"], { q1: 2, q2: 2, q3: 2 }, { lanes: 3, maxMin: 40 });
  t("小さい依頼は分けない", small.length === 1 && small[0].length === 3);
  t("12問の上限は今まで通り", splitByTime(Array.from({ length: 20 }, (_, k) => "x" + k), {}, { lanes: 6, maxMin: 600 }).every((x) => x.length <= 12)); }
{ // 2026-11-05 止めた回の片付け先（弱い所 id 293）: レーン・main の子の会話を全部
  const lane = "レーン（EXAM_CONCURRENCY=4）: 4本 YUMA2（d040f80a・線 scripts/.replay-out/brain-exam-floor-off-g1-r-yuma2.json）・YUMA3（f7deb105・線 scripts/.replay-out/brain-exam-floor-off-g1-r-yuma3.json）";
  const child = "レーン（EXAM_CONCURRENCY=2）: 2本 YUMA4（40f0db25・線 scripts/.replay-out/brain-exam-floor-main-97fe109-7ee4d13f90-rmw2-yuma4.json）・YUMA5（a7ac4c90・線 scripts/.replay-out/brain-exam-floor-main-97fe109-7ee4d13f90-rmw2-yuma5.json）";
  const ts = cleanupTargets(child + "\n" + lane, "off-g1-r");
  t("片付け先: レーンの会話を全部（今の回と main の子）", ts.length === 4 && ts.filter((x) => x.child).map((x) => x.conv).join() === "YUMA4,YUMA5" && ts.filter((x) => !x.child).map((x) => x.conv).join() === "YUMA2,YUMA3");
  const one = cleanupTargets("テストの会話: YUMA2（d040f80a-4fae-4fd0-abca-66eb2630906f）・鍵 scripts/.replay-out/.test-conv-YUMA2.lock・線 scripts/.replay-out/brain-exam-floor-cbp1-yuma2.json", "cbp1");
  t("片付け先: 1本の回は今まで通りその会話", one.length === 1 && one[0].conv === "YUMA2" && one[0].label === "cbp1" && !one[0].child);
  t("片付け先: 読めなければ空", cleanupTargets("なにも無い", "x").length === 0); }
t("組み立ての状態: inspect の表が stderr だけに出ても READY を読む（11/06 tsc-ocr-on2）", remoteDeployState(inspectOutputText({ stdout: Buffer.from(""), stderr: Buffer.from("\nVercel CLI 55.0.0\n  General\n\n    id\t\tdpl_7zPK\n    status\t● Ready\n") })) === "READY" && remoteDeployState(inspectOutputText({ stdout: "", stderr: "" })) === null && remoteDeployState(inspectOutputText(null)) === null);
t("組み立ての状態: inspect の READY・Building・Error を読む（作業員3の気付き）", remoteDeployState("  General\n\n    id\t\tdpl_x\n    status\t● Ready\n") === "READY" && remoteDeployState("status\t● Building") === "BUILDING" && remoteDeployState("status ● Error") === "ERROR" && remoteDeployState("なし") === null);
t("比べた問題: 基準の回が無い＝0（悪化0と言わない）", comparedIds([{ id: "q1", rep: 1, score: { pass: true } }], []).length === 0);
t("比べた問題: 両方で失敗・混ざりの無い回がある問題だけ", JSON.stringify(comparedIds([{ id: "q1", rep: 1 }, { id: "q2", rep: 1, error: "x" }, { id: "q3", rep: 1, foreignMsgs: 2 }, { id: "q4", rep: 1 }], [{ id: "q1", rep: 1 }, { id: "q2", rep: 1 }, { id: "q3", rep: 1 }])) === JSON.stringify(["q1"]));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
