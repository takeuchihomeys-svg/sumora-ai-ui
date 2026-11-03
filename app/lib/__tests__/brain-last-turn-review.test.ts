// app/lib/__tests__/brain-last-turn-review.test.ts — 前回の提案の振り返り（2026-11-03・②⑤）
//   実行: npx tsx app/lib/__tests__/brain-last-turn-review.test.ts
import { brainLastTurnReviewOn, reviewLastTurn, lastTurnReviewLine, lastTurnReviewDigest } from "../brain-last-turn-review";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, v?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(v)); } };
const ja = (k: string) => ({ property_check_result: "物件確認した", estimate_sheet: "見積書送る", property_send: "物件ピックアップした", property_recommendation: "物件オススメ" } as Record<string, string>)[k] ?? k;
const prev = { at: "2026-11-01T01:00:00Z", action: "property_check_result", replyMode: "aix", stage: "proposing" };

t("既定は yuma（YUMA だけ）・=on で全部・=off で止まる", brainLastTurnReviewOn({}, "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7") && !brainLastTurnReviewOn({}, "real-conv") && brainLastTurnReviewOn({ BRAIN_LAST_TURN_REVIEW: "on" }, "real-conv") && !brainLastTurnReviewOn({ BRAIN_LAST_TURN_REVIEW: "off" }, "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"));
t("前回が無ければ null", reviewLastTurn({ prev: null, actsAfter: [], stageNow: null }) === null);
const r1 = reviewLastTurn({ prev, actsAfter: [{ at: "2026-11-01T02:00:00Z", kind: "aix", aixType: "estimate_sheet", writer: "takeuchi" }], stageNow: "estimate_sent" })!;
t("違う AIX・竹内さん・進んだ", r1.match === "diff" && r1.writer === "takeuchi" && r1.progress === "forward", r1);
const l1 = lastTurnReviewLine(r1, ja);
t("1行: 違った事実・竹内さんは重く・理由を考える", l1.includes("物件確認した を勧めたが") && l1.includes("見積書送る") && l1.includes("重く見る") && l1.includes("なぜ違う手"), l1);
const r2 = reviewLastTurn({ prev, actsAfter: [{ at: "2026-11-01T02:00:00Z", kind: "aix", aixType: "acknowledge_check", writer: "employee" }], stageNow: "proposing" })!;
t("同じ系統（確認）は当たり", r2.match === "same" && r2.progress === "same", r2);
const r3 = reviewLastTurn({ prev: { ...prev, action: null, replyMode: "auto_reply" }, actsAfter: [{ at: "2026-11-01T02:00:00Z", kind: "text", aixType: null, writer: "employee" }], stageNow: "proposing" })!;
t("返信を勧めて手打ち＝当たり", r3.match === "reply_ok" && lastTurnReviewLine(r3, ja).includes("当たった"), r3);
const r4 = reviewLastTurn({ prev: { ...prev, action: null, replyMode: "auto_reply" }, actsAfter: [{ at: "2026-11-01T02:00:00Z", kind: "text", aixType: null, writer: "employee" }, { at: "2026-11-01T02:01:00Z", kind: "aix", aixType: "property_send", writer: "employee" }], stageNow: null })!;
t("返信を勧めたがスタッフは AIX＝違い・押し間違いの時もある", r4.match === "diff" && r4.staff === "property_send" && lastTurnReviewLine(r4, ja).includes("押し間違いの時もある") && r4.progress === "unknown", r4);
const r5 = reviewLastTurn({ prev, actsAfter: [{ at: "2026-10-31T02:00:00Z", kind: "aix", aixType: "estimate_sheet", writer: "employee" }], stageNow: "proposing" })!;
t("前回より前の一手は数えない（none は1行なし）", r5.match === "none" && lastTurnReviewLine(r5, ja) === "", r5);
t("戻った", reviewLastTurn({ prev: { ...prev, stage: "viewed" }, actsAfter: [], stageNow: "searching" })!.progress === "back");
t("digest の形", JSON.stringify(lastTurnReviewDigest(r1)) === '{"p":"property_check_result","s":"estimate_sheet","m":"diff","w":"takeuchi","g":"forward"}', lastTurnReviewDigest(r1));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
