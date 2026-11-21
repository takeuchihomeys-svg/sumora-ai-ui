// 指示書の空の欄を型の表から埋める（BRIEF_FILL_FROM_TYPE・作業員M 2026-11-21・台帳 #465）
// 実行: npx tsx app/lib/__tests__/conductor-brief-fill.test.ts
import { buildConductorBrief, briefFillFromTypeOn, briefTypeFallbackOf, BRIEF_NONE } from "../conductor-brief";
import { TYPE_INTENT } from "../check-order";
export {};
let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };
const withEnv = <T>(v: string | undefined, f: () => T): T => { const old = process.env.BRIEF_FILL_FROM_TYPE; if (v === undefined) delete process.env.BRIEF_FILL_FROM_TYPE; else process.env.BRIEF_FILL_FROM_TYPE = v; try { return f(); } finally { if (old === undefined) delete process.env.BRIEF_FILL_FROM_TYPE; else process.env.BRIEF_FILL_FROM_TYPE = old; } };

t("既定 off", !briefFillFromTypeOn({}) && briefFillFromTypeOn({ BRIEF_FILL_FROM_TYPE: "on" }));
t("型の候補が空: 内覧の話だけ T7・約束だけは埋めない", briefTypeFallbackOf(["pendingPromise", "topic:viewing"]) === "T7_viewing" && briefTypeFallbackOf(["pendingPromise"]) === null && briefTypeFallbackOf(null) === null);

// 本番の 11/21 の形（check_order の候補が空・手がかり pendingPromise と topic:viewing）
const mViewing = { check_order: { why: null, cues: ["pendingPromise", "topic:viewing"], type: null, cands: [], scene: "viewing" }, check_order_scene: "viewing" };
const offV = withEnv(undefined, () => buildConductorBrief(mViewing));
const onV = withEnv("on", () => buildConductorBrief(mViewing));
t("off: 今のまま（型は 未）", offV.type === BRIEF_NONE && offV.aim.keyPoint === BRIEF_NONE);
t("on: 内覧の話は T7・要点と中期が型の表から", onV.type !== BRIEF_NONE && onV.type.id === "T7_viewing" && onV.aim.keyPoint === TYPE_INTENT.T7_viewing.keyPoint.slice(0, 50) && onV.aim.keyPointFrom === "type_table" && onV.aim.midFrom === "type_table" && onV.aim.mid === "viewing" && !onV.notYet.includes("key_point") && !onV.notYet.includes("mid"), { type: onV.type, aim: onV.aim });
const mPromise = { check_order: { why: null, cues: ["pendingPromise"], type: null, cands: [], scene: "other" } };
const onP = withEnv("on", () => buildConductorBrief(mPromise));
t("on: 約束だけの番は型を作らない（竹内さんの番を数えてから）", onP.type === BRIEF_NONE && onP.aim.keyPoint === BRIEF_NONE);
// 型がある番（T5 お礼）
const mAck = { check_order_type: "T5_ack_hypothesis", check_order: { cues: ["ackOnly"], type: "T5_ack_hypothesis", cands: [], scene: "ack" } };
const onA = withEnv("on", () => buildConductorBrief(mAck));
t("on: 型がある番は要点を型の表から", onA.aim.keyPoint === TYPE_INTENT.T5_ack_hypothesis.keyPoint.slice(0, 50) && onA.aim.keyPointFrom === "type_table");
const onJ = withEnv("on", () => buildConductorBrief({ ...mAck, judge_basis: { purpose: "answer", key_point: "元の要点" }, turn_aims_after: { midAim: "元の中期" } }));
t("on: 判断の根拠・turn_aims の値は上書きしない", onJ.aim.keyPoint === "元の要点" && onJ.aim.keyPointFrom === undefined && onJ.aim.mid === "元の中期" && onJ.aim.midFrom === undefined, onJ.aim);

console.log(`\nconductor-brief-fill: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
