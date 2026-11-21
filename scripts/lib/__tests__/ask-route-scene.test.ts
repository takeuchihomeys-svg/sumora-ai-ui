// 要件の場面の形（作業員M 2026-11-21・台帳 #503）
// 実行: npx tsx scripts/lib/__tests__/ask-route-scene.test.ts
import { takeuchiShapeLabel, sceneShapeVerdict } from "../ask-route-of";
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
console.log(`ask-route-scene: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
