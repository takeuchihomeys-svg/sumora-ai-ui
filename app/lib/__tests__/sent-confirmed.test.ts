// 「こちらが送った物件＝送った時点で募集中を確認済み」の材料（2026-10-28 竹内さん・10/20 の画面）
// 実行: npx tsx app/lib/__tests__/sent-confirmed.test.ts
import { sentConfirmedNoteEnabled, sentPropertiesOf, buildSentConfirmedNote } from "../sent-confirmed";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-20T06:22:36Z");
const sent = (names: string[], daysAgo: number, kind = "properties_sent", status = "done") => ({ kind, status, at: new Date(NOW - daysAgo * DAY).toISOString(), detail: { propertyNames: names } });

it("既定 off・on で入る", () => { eq(sentConfirmedNoteEnabled({}), false); eq(sentConfirmedNoteEnabled({ SENT_CONFIRMED_NOTE: "on" }), true); });
it("送った物件だけ・同じ名前は新しい送付・21日より古い物と宣言は入れない・新しい順", () => {
  const e = [sent(["Tio Verde 301号室"], 0.1), sent(["物件A", "Tio Verde 301号室"], 3), sent(["古い物件"], 30), sent(["宣言だけ"], 1, "pickup_declared", "promised")];
  eq(sentPropertiesOf(e, NOW).map((p) => `${p.name}:${p.days}`), ["Tio Verde 301号室:0", "物件A:3"]);
});
it("和樹の形: 今日送った物件は「送った時点で募集中を確認済み」・確認を約束する場面ではない旨", () => {
  const n = buildSentConfirmedNote([sent(["Tio Verde 301号室"], 0.1)], NOW);
  ok(/Tio Verde 301号室（今日に送付）＝送った時点で募集中を確認済み/.test(n), n);
  ok(/募集状況の確認を約束する場面ではない/.test(n), n);
  ok(/近づけられるよう」と約束しない/.test(n), n);
  ok(/持ち込んだ物件（SUUMO 等の画面・URL）はこれと別で確認が要る/.test(n), n);
});
it("7日を超えた物件は念のための確認", () => ok(/送ってから7日を超えた/.test(buildSentConfirmedNote([sent(["物件B"], 9)], NOW))));
it("送った物件が無ければ空（プロンプトは変わらない）", () => eq(buildSentConfirmedNote([], NOW), ""));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
