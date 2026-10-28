// 送った事の重要な5つをメモへ（2026-10-28 竹内さん）
// 実行: npx tsx app/lib/__tests__/ledger-memo.test.ts
import { ledgerMemoSyncEnabled, ledgerMemoItems, mergeLedgerMemo, diffAndDateItemsOf, isLedgerMemoItem, LEDGER_MEMO_MAX } from "../ledger-memo";
import { itemsFromLedger, explainedItemsOf } from "../sent-ledger-bind";
import { EMPTY_MEMO } from "../customer-memo";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const NOW = "2026-10-28T10:00:00Z";

it("既定 on・off で止める", () => { eq(ledgerMemoSyncEnabled({}), true); eq(ledgerMemoSyncEnabled({ LEDGER_MEMO_SYNC: "off" }), false); });
it("金額・確認の結果・断った事を写す（決まった id・同じ事は1行）", () => {
  const items = [
    ...itemsFromLedger([
      { kind: "estimate_sent", status: "done", at: "2026-10-26T07:00:00Z", evidence: "【アーバネックス堺筋本町 701号室】初期費用173,480円", detail: { estimateFor: ["アーバネックス堺筋本町 701号室"] } },
      { kind: "confirmation_reported", status: "done", at: "2026-10-27T07:00:00Z", evidence: "現在募集中となります", detail: { propertyNames: ["Tio Verde 302号室"], propStatuses: ["募集中"] } },
    ]),
    ...explainedItemsOf("駐車場は現在満車のため、ご用意が難しい状況です。", "2026-10-27T08:00:00Z"),
  ];
  const rows = ledgerMemoItems({ items, staffTexts: [], nowIso: NOW });
  const texts = rows.map((r) => r.text);
  ok(texts.some((t) => /【金額】アーバネックス堺筋本町 701号室 御見積書 初期費用 173,480円/.test(t)), texts.join(" / "));
  ok(texts.some((t) => /【確認の結果】Tio Verde 302号室: 募集中/.test(t)), texts.join(" / "));
  ok(texts.some((t) => /【お断りした事】駐車場/.test(t)), texts.join(" / "));
  ok(rows.every(isLedgerMemoItem) && rows.every((r) => r.kind === "told" && r.sourceBy === "staff"));
  eq(ledgerMemoItems({ items, staffTexts: [], nowIso: NOW }).map((r) => r.id), rows.map((r) => r.id), "同じ id");
});
it("条件との違い・期日をこちらの文から拾う（約束は拾わない）", () => {
  eq(diffAndDateItemsOf("ご希望のカウンターキッチンでは御座いませんが、バス・トイレ別のお部屋となります！！", NOW).map((d) => d.cat), ["diff"]);
  eq(diffAndDateItemsOf("こちら11/1以降のご案内となります！！", NOW).map((d) => d.cat), ["date"]);
  eq(diffAndDateItemsOf("11/1に内覧のご案内させて頂きます！！", NOW), []);
});
it("足すのは無い id だけ・上限を超えたら古い順に外す・何も無ければ null", () => {
  const rows = ledgerMemoItems({ items: [], staffTexts: [{ text: "こちら11/1以降のご案内となります！！", at: NOW }], nowIso: NOW });
  const m1 = mergeLedgerMemo(EMPTY_MEMO, rows, NOW)!;
  eq(m1.items.length, 1);
  eq(mergeLedgerMemo(m1, rows, NOW), null);
  const many = Array.from({ length: LEDGER_MEMO_MAX + 2 }, (_, k) => ledgerMemoItems({ items: [], staffTexts: [{ text: `こちら11/${k + 1}以降のご案内となります！！`, at: new Date(Date.parse(NOW) + k * 60_000).toISOString() }], nowIso: NOW })[0]);
  const m2 = mergeLedgerMemo(EMPTY_MEMO, many, NOW)!;
  eq(m2.items.filter((x) => !x.retiredAt).length, LEDGER_MEMO_MAX);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
