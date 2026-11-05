// 実行: npx tsx app/lib/__tests__/customer-fact-ledger.test.ts
import { buildFactLedger, factConflicts, factLedgerBlock, factLedgerMode, factLedgerOpenPromiseOn, openPromiseValue, ledgerFactsFrom } from "../customer-fact-ledger";
import { buildActionLedger } from "../action-ledger";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// 2026-11-05 作業員3: 開いている約束を種類ごとに（FACT_LEDGER_OPEN_PROMISE・既定 off）
it("開いている約束: 既定 on・off は今まで通りの英語名", () => {
  ok(factLedgerOpenPromiseOn({}) && !factLedgerOpenPromiseOn({ FACT_LEDGER_OPEN_PROMISE: "off" }));
  const f = buildFactLedger({ ledger: [{ kind: "pickup_declared", status: "promised", at: null }] }, { FACT_LEDGER_OPEN_PROMISE: "off" });
  ok(f[0].value === "pickup_declared", f[0].value);
});
it("開いている約束: 種類ごとに次の一手／結果待ち／果たした", () => {
  ok(openPromiseValue("pickup_declared", "", false).includes("次の一手で果たす番（物件を送る AIX）"));
  ok(openPromiseValue("estimate_declared", "Aハイツ", false).includes("御見積書・Aハイツ") && openPromiseValue("estimate_declared", "", false).includes("御見積書の AIX"));
  const c = openPromiseValue("confirmation_promised", "駐車場", false);
  ok(c.includes("結果待ち") && c.includes("確かめた記録が付いてから") && !c.includes("果たす番"), c);
  // ピックアップの約束に「確かめてから」を付けない（w2 版の止める方の言い方を採らない）
  ok(!openPromiseValue("pickup_declared", "", false).includes("確かめた記録"));
  ok(openPromiseValue("pickup_declared", "", true).endsWith("＝果たした"));
});
it("開いている約束: 14日より古い約束は果たす番と書かない（KB 7323e80a）", () => {
  const now = Date.parse("2026-11-05T12:00:00+09:00");
  const f = buildFactLedger({ nowMs: now, ledger: [
    { kind: "pickup_declared", status: "promised", at: "2026-10-01T12:00:00+09:00" },
    { kind: "estimate_declared", status: "promised", at: "2026-11-05T11:00:00+09:00" },
  ] }, { FACT_LEDGER_OPEN_PROMISE: "on" });
  ok(f[0].value.includes("14日以上前") && !f[0].value.includes("果たす番"), f[0].value);
  ok(f[1].value.includes("次の一手で果たす番（御見積書の AIX）"), f[1].value);
});
it("配線: 8873 型（ピックアップの約束→スタンプ→持ち込み）を行動台帳から帳面のブロックまで", () => {
  const T = (s: string) => `2026-10-28T${s}:00+09:00`;
  const msgs = [
    { sender: "customer", text: "12月中旬\n管理費込み13万円\n1LDK\n北浜らへん", createdAt: T("16:18") },
    { sender: "staff", text: "はじめまして😊！！\n北浜周辺全域から管理費込み13万円以内・1LDKでできるだけ広めのお部屋をピックアップしてお送りさせて頂きます！！", createdAt: T("16:20") },
    { sender: "customer", text: "[スタンプ]", createdAt: T("16:21") },
    { sender: "customer", text: "この物件の詳細もお願いしたいです", createdAt: T("16:24") },
  ] as Parameters<typeof buildActionLedger>[0]["messages"];
  const led = buildActionLedger({ messages: msgs, lastCustomerAt: T("16:24"), now: Date.parse(T("16:25")) });
  ok(led.entries.some((e) => e.kind === "pickup_declared" && e.status === "promised" && e.fulfilledBy == null), JSON.stringify(led.entries.map((e) => [e.kind, e.status, e.fulfilledBy])));
  const on = factLedgerBlock(buildFactLedger({ ledger: ledgerFactsFrom(led.entries) }, { FACT_LEDGER_OPEN_PROMISE: "on" }), Date.parse(T("16:25")));
  ok(on.includes("物件のピックアップ") && on.includes("次の一手で果たす番（物件を送る AIX）"), on);
  const off = factLedgerBlock(buildFactLedger({ ledger: ledgerFactsFrom(led.entries) }, { FACT_LEDGER_OPEN_PROMISE: "off" }), Date.parse(T("16:25")));
  ok(!off.includes("次の一手で果たす番"), off);
  // 物件を送った後は「果たした」
  const led2 = buildActionLedger({ messages: msgs, recentAixRows: [{ aix_type: "property_send", sent_at: T("16:40"), created_at: T("16:39") }] as never, lastCustomerAt: T("16:24"), now: Date.parse(T("16:41")) });
  const on2 = factLedgerBlock(buildFactLedger({ ledger: ledgerFactsFrom(led2.entries) }, { FACT_LEDGER_OPEN_PROMISE: "on" }), Date.parse(T("16:41")));
  ok(/物件のピックアップ[^）]*）＝果たした/.test(on2) && !on2.includes("次の一手で果たす番"), on2);
});
it("配線: brain-core は行動台帳を ledgerFactsFrom で帳面に渡す（果たしたかどうかが落ちない）", () => {
  const src = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
  ok(/buildFactLedger\(\{[\s\S]{0,900}ledger: ledgerFactsFrom\(brainLedger\.entries\)/.test(src), "brain-core の buildFactLedger の ledger が ledgerFactsFrom でない");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
