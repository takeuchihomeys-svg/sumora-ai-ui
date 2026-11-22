// 要件の場面の形（作業員M 2026-11-21・台帳 #503）
// 実行: npx tsx scripts/lib/__tests__/ask-route-scene.test.ts
import { takeuchiShapeLabel, sceneShapeVerdict, staffScheduleInText, askTurnClass, askDailyCounts } from "../ask-route-of";
export {};
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (c) pass++; else { fail++; console.error("NG", n, x ?? ""); } };
const t0 = Date.parse("2026-11-08T04:00:00Z"), s = (sec: number) => t0 + sec * 1000;
ok("返信だけ", takeuchiShapeLabel(t0, [{ at: s(60), aix: false }, { at: s(90), aix: false }], []) === "R");
ok("返信→すぐ AIX", takeuchiShapeLabel(t0, [{ at: s(60), aix: false }, { at: s(120), aix: true }], ["property_send"]) === "R→A:property_send");
ok("返信→1時間より後の AIX", takeuchiShapeLabel(t0, [{ at: s(60), aix: false }, { at: s(4000), aix: true }], ["property_check_result"]) === "R→後でA:property_check_result");
ok("AIX→返信→AIX", takeuchiShapeLabel(t0, [{ at: s(60), aix: true }, { at: s(90), aix: false }, { at: s(120), aix: true }], ["estimate_sheet"]) === "A:estimate_sheet→R→A");
const m = (o: Record<string, number>) => new Map(Object.entries(o));
const v1 = sceneShapeVerdict("返信:条件提示", m({ "R": 2, "R→後でA:property_send": 6 }));
ok("過半数→設計知見の案", v1.kind === "kb" && v1.top === "R→後でA:property_send" && Math.round(v1.share * 100) === 75, v1);
const v2 = sceneShapeVerdict("返信:検討中・一時保留", m({ "R": 3, "R→A:property_send": 3 }));
ok("割れた→確認案（推奨は多い方）", v2.kind === "ask" && v2.share === 0.5, v2);
ok("少ない→決めない", sceneShapeVerdict("返信:持ち込み物件", m({ "R": 2 })).kind === "few");
ok("手打ちの候補の日時＝スタッフの予定", staffScheduleInText("弊社直近ですと 本日18:00〜18:30 明日 12:00〜16:00 ご案内可能です！！") && staffScheduleInText("直近ですと 10/16(金) 13:00〜15:00") && !staffScheduleInText("ご都合よろしいお日にちを教えてください") && !staffScheduleInText("28の17時でお願いします"));
// #520: 番1つの分けと毎日の数（audit-ask-route-takeuchi と同じ数え方）
const tcR = "1:r1p0a0n0"; // 要件1つ・返信（digest.tc の形）
const cls1 = askTurnClass({ tc: tcR, turnAt: t0, moves: [{ at: s(60), aix: false, text: "かしこまりました" }], kinds: [], brainAction: null });
const cls2 = askTurnClass({ tc: "1:r0p0a1n0", turnAt: t0, moves: [{ at: s(60), aix: false, text: "弊社直近ですと 本日18:00〜18:30 ご案内可能です" }], kinds: [], brainAction: "viewing_invite" });
const cls3 = askTurnClass({ tc: null, turnAt: t0, moves: [{ at: s(60), aix: false }], kinds: [], brainAction: null });
ok("番の分け（返信の要件に返信＝合う・手打ちの予定＝合う・記録なし）", cls1 === "合う" && cls2 === "合う" && cls3 === "記録なし", { cls1, cls2, cls3 });
const d = askDailyCounts(["合う", "合う", "取りこぼし", "記録なし", "取り違え"]);
ok("毎日の数（記録なしは分母に入れない）", d.n === 4 && d.合う === 2 && d.取りこぼし === 1 && d.取り違え === 1 && d.合う率 === 50, d);
// 2cb0feb7 の型（伏せた形）: 了承の番・ブレインは返信・竹内さんは返信→57分後に AIX（前の番の確認＋ピックアップの約束の果たし）
const prevT = ["かしこまりました！！ 〇〇の募集状況確認させて頂きます！！", "あわせて〇〇周辺から新たにピックアップしてお送りさせて頂きます！！"];
const mv = [{ at: s(150), aix: false, text: "確認出来次第ご連絡させて頂きます" }, { at: s(57 * 60), aix: true }];
ok("前の番の約束を果たす AIX は要件の外（2cb0feb7）", askTurnClass({ tc: "1:r1p0a0n0", turnAt: t0, moves: mv, kinds: ["property_check_result", "物件の束"], brainAction: null, prevStaffTexts: prevT }) === "合う" && askTurnClass({ tc: "1:r1p0a0n0", turnAt: t0, moves: mv, kinds: ["property_check_result"], brainAction: null }) === "取りこぼし");
console.log(`ask-route-scene: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
