// 送った事の台帳と結び付け（2026-10-28 竹内さんの決定）
// 実行: npx tsx app/lib/__tests__/sent-ledger-bind.test.ts
import { sentLedgerBindEnabled, explainedItemsOf, itemsFromLedger, bindReaction, bindMaterialLine } from "../sent-ledger-bind";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const NOW = Date.parse("2026-10-20T10:00:00Z");
const LEDGER = [
  { kind: "properties_sent", status: "done", at: "2026-10-19T09:00:00Z", evidence: "🌟Tio Verde 302号室", detail: { propertyNames: ["Tio Verde 302号室", "シーズンフラッツ心斎橋イースト 204号室"] } },
  { kind: "estimate_sent", status: "done", at: "2026-10-20T08:00:00Z", evidence: "初期費用173,480円", detail: { estimateFor: ["アーバネックス堺筋本町 701号室"] } },
];

it("既定 on・off で止める", () => { eq(sentLedgerBindEnabled({}), true); eq(sentLedgerBindEnabled({ SENT_LEDGER_BIND: "off" }), false); eq(sentLedgerBindEnabled({ SENT_LEDGER_BIND: "on" }), true); });
it("説明した事・断った事を拾う（約束は拾わない）", () => {
  const t = "こちらのお部屋はインターネット無料となります！！\n駐車場は現在満車のため、ご用意が難しい状況です。\n違約金につきましては確認させて頂きます！！";
  const items = explainedItemsOf(t, "2026-10-20T07:00:00Z", "m1");
  eq(items.map((i) => `${i.kind}:${i.topic}`), ["explained:ネット", "declined:駐車場"]);
});
it("物件名の頭で結ぶ（和樹: 送った物件の費用の質問）→ 送った時点で確認済みの事実", () => {
  const b = bindReaction({ customerText: "Tio Verdeの初期費用はどうなりますか？", items: itemsFromLedger(LEDGER), nowMs: NOW })!;
  eq([b.by, b.item.kind, b.item.name], ["name", "property", "Tio Verde 302号室"]);
  ok(/確認済み/.test(bindMaterialLine(b, NOW)));
});
it("引用で結ぶ（☆: 見積書の物件への質問）", () => {
  const b = bindReaction({ customerText: "床の色白ですか？", quotedText: "【アーバネックス堺筋本町 701号室】初期費用173,480円", items: itemsFromLedger(LEDGER), nowMs: NOW })!;
  eq([b.by, b.item.name], ["quote", "アーバネックス堺筋本町 701号室"]);
});
it("話題で結ぶ（説明した事への反応）", () => {
  const items = [...itemsFromLedger(LEDGER), ...explainedItemsOf("ネット無料となります！！", "2026-10-20T09:00:00Z", "m2")];
  const b = bindReaction({ customerText: "ネットは速いですか？", items, nowMs: NOW })!;
  eq([b.by, b.item.kind, b.item.topic], ["topic", "explained", "ネット"]);
});
it("手がかりが無い長い文は結ばない（推測しない）", () => {
  eq(bindReaction({ customerText: "来月から仕事が変わるので、通勤のしやすい場所でまた考えてみようと思っています", items: itemsFromLedger(LEDGER), nowMs: Date.parse("2026-10-22T10:00:00Z") }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
