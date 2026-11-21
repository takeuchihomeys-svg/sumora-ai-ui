// 画像の読みの目の監査（種類を問わず・2026-11-21 作業員G・#510）
// 実行: npx tsx app/lib/__tests__/image-audit.test.ts
import { auditLedgerNote, auditReport, parseJudgeArg } from "../image-audit";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

const reads = [
  { id: "1", read: "ok" }, { id: "2", read: "ng" }, { id: "3", read: "unknown" }, { id: "4", read: "ng" }, { id: "5", read: "ok" },
  { id: "6", read: "Uresidence 新大阪" }, { id: "1", read: "ng" },   // 同じ id は最後の読み
];
const truth = { "1": "ng", "2": "ng", "3": "ok", "4": "ok", "6": "Uresidence新大阪", "7": "ok" };
const r = auditReport(reads, truth, 3);
ok("最後の読みを使う（1 は ng で正しい）", !r.wrongIds.some((w) => w.id === "1"));
ok("正しい 3（1・2・6）・誤り 1（4）", r.right === 3 && r.wrong === 1 && r.wrongIds[0].id === "4");
ok("分からないは誤りに数えない（3）", r.unknown === 1);
ok("まだ見ていない（5）", r.notJudged === 1);
ok("誤りがあれば使わない", r.ready === false);
ok("誤り0・正しい3以上なら使ってよい", auditReport([{ id: "a", read: "ok" }, { id: "b", read: "ng" }, { id: "c", read: "ok" }], { a: "ok", b: "ng", c: "ok" }, 3).ready === true);
ok("目でも決められない物は数えない", auditReport([{ id: "a", read: "ok" }], { a: "unknown" }).undecidable === 1);
ok("--judge を読む", JSON.stringify(parseJudgeArg("166151:ok, 169742:ng")) === JSON.stringify([{ id: "166151", value: "ok" }, { id: "169742", value: "ng" }]));
let threw = false; try { parseJudgeArg("x"); } catch { threw = true; }
ok("形が違えば止める", threw);
ok("台帳の1行に件数と判定", /正しい 3・誤り 1/.test(auditLedgerNote("counter_kitchen", r)) && /まだ使わない/.test(auditLedgerNote("counter_kitchen", r)));

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
