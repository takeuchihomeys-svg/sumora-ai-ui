// 実行: npx tsx app/lib/__tests__/customer-fact-ledger.test.ts
import { buildFactLedger, factConflicts, factLedgerBlock, factLedgerMode } from "../customer-fact-ledger";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const NOW = Date.parse("2026-11-03T12:00:00+09:00");

it("既定 shadow・off で止まる", () => { ok(factLedgerMode({}) === "shadow"); ok(factLedgerMode({ CUSTOMER_FACT_LEDGER: "off" }) === "off"); ok(factLedgerMode({ CUSTOMER_FACT_LEDGER: "on" }) === "on"); });
it("束ねて出所と時刻を付ける・一次が先", () => {
  const f = buildFactLedger({
    state: { stage: "viewing_scheduled", stageLabel: "内覧予定", since: "2026-11-02T10:00:00+09:00", properties: [{ key: "a|301", name: "Aハイツ 301", statusLabel: "内覧予定", lastAt: "2026-11-02T10:00:00+09:00", estimateSent: true, sentByUs: true, customerInterest: true }], viewings: [{ ymd: "2026-11-05", time: "14:00", name: "Aハイツ 301" }] },
    ledger: [{ kind: "confirmation_promised", status: "promised", at: "2026-11-03T09:00:00+09:00", detail: { object: "駐車場の空き" } }],
    memo: [{ kind: "相談相手", text: "彼氏と決める", at: "2026-11-01T09:00:00+09:00" }, { kind: "古い", text: "x", retiredAt: "2026-11-02T00:00:00Z" }],
    meta: { plan_ahead: { goal: "今週中に内覧", steps: ["見積書", "内覧"] }, plan_ahead_at: "2026-11-03T08:00:00+09:00", three_layer: { worry: "予算が足りるか" } },
    strategy: { checkpoint_stage: "proposing", strategy_analyzed_at: "2026-11-01T10:00:00+09:00" },
  });
  ok(f.filter((x) => x.kind === "memo").length === 1);
  const st = f.filter((x) => x.key === "stage");
  ok(st[0].source === "state" && st[1].source === "strategy", JSON.stringify(st));
  ok(factConflicts(f).length === 1 && factConflicts(f)[0].key === "stage");
  const b = factLedgerBlock(f, NOW);
  ok(b.includes("Aハイツ 301（内覧予定・送付・見積済・名指し）（記録") && b.includes("【帳面の食い違い】stage: 記録=内覧予定／全体の分析=proposing") && b.includes("駐車場の空き"), b);
});
it("空なら空", () => { ok(factLedgerBlock(buildFactLedger({}), NOW) === ""); });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
