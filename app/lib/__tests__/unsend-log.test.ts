// 実行: npx tsx app/lib/__tests__/unsend-log.test.ts
import { unsendLogOn, unsendLogRow, unsendPurgeBefore, UNSEND_HEAD_CHARS } from "../unsend-log";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
it("既定 off", () => { ok(!unsendLogOn({})); ok(unsendLogOn({ UNSEND_LOG: "on" })); });
it("=yuma は YUMA の会話だけ", () => {
  ok(unsendLogOn({ UNSEND_LOG: "yuma" }, "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"));
  ok(!unsendLogOn({ UNSEND_LOG: "yuma" }, "c1")); ok(!unsendLogOn({ UNSEND_LOG: "yuma" }));
});
it("伏せた頭40字だけ・電話番号は伏せる", () => {
  const r = unsendLogRow({ conversationId: "c1", sender: "customer", createdAt: "2026-11-13T01:00:00Z", text: "電話番号は090-1234-5678です。".repeat(5), postApply: false, nowIso: "2026-11-13T02:00:00Z" })!;
  ok(r.text_head!.length <= UNSEND_HEAD_CHARS, String(r.text_head?.length)); ok(!r.text_head!.includes("1234-5678"), r.text_head!);
  ok(r.conversation_id === "c1" && r.original_sent_at === "2026-11-13T01:00:00Z" && r.sender === "customer" && r.unsent_at === "2026-11-13T02:00:00Z");
});
it("申込以降・会話が分からない時は残さない", () => {
  ok(unsendLogRow({ conversationId: "c1", sender: "customer", createdAt: null, text: "x", postApply: true }) === null);
  ok(unsendLogRow({ conversationId: null, sender: "customer", createdAt: null, text: "x", postApply: false }) === null);
});
it("30日より古い控えを消す線", () => { ok(unsendPurgeBefore(Date.parse("2026-11-13T00:00:00Z")) === "2026-10-14T00:00:00.000Z"); });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
