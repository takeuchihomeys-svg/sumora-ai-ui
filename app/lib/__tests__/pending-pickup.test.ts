// 未履行の物件ピックアップ宣言（＝次は物件を送る場面）の判定テスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/pending-pickup.test.ts
import { resolvePendingPickup, PENDING_PICKUP_MAX_HOURS } from "../pending-pickup";
import { buildActionLedger } from "../action-ledger";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const falsy = (a: unknown, m = "") => { if (a) throw new Error(`expected falsy ${m}`); };
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };

const NOW = Date.parse("2026-09-23T05:00:00Z"); // JST 14:00（実物のスクリーンショットの時刻）
const H = 3_600_000;

describe("台帳から: あっぴさんの実物（宣言 9/22 10:04 → 顧客の了承 9/23 13:48）", () => {
  // 実物の本文をそのまま台帳に通す
  const ledger = buildActionLedger({
    messages: [
      { sender: "staff", text: "本日はお時間頂きありがとうございました！！", createdAt: "2026-09-21T05:00:00Z" },
      { sender: "customer", text: "1個目間取りがいいですけど家賃が安いと嬉しかったですね！", createdAt: "2026-09-21T06:00:00Z" },
      { sender: "staff", text: "かしこまりました😊！！\n新着であっぴさんにオススメ出来るお部屋募集出次第お送りさせて頂きます！！\n何卒よろしくお願い致します😌", createdAt: "2026-09-22T01:04:00Z" },
      { sender: "customer", text: "よろしくお願いしますッ！\n条件が合う物件に巡り会えたらいいなと思います", createdAt: "2026-09-23T04:48:00Z" },
    ],
    now: NOW,
  });
  it("台帳が未履行のピックアップ宣言を持っている", () => truthy(ledger.facts.pickupPromisedUnfulfilled));
  it("未履行 → 次は物件を送る場面（pending）", () => {
    const r = resolvePendingPickup(ledger.facts, { now: NOW });
    truthy(r.pending);
    eq(r.reason, "pending_pickup");
  });
});

describe("壊してはいけない既存の線", () => {
  const base = { pickupPromisedUnfulfilled: true, pickupPromisedAt: "2026-09-22T01:04:00Z", lastPropertiesSentAt: null as string | null };
  it("宣言が無ければ立てない", () =>
    falsy(resolvePendingPickup({ ...base, pickupPromisedUnfulfilled: false }, { now: NOW }).pending));
  it("物件送付直後の反応待ち（宣言の後に送付済み）は立てない", () => {
    const r = resolvePendingPickup({ ...base, lastPropertiesSentAt: "2026-09-22T03:00:00Z" }, { now: NOW });
    falsy(r.pending);
    eq(r.reason, "fulfilled");
  });
  it("お客様がこれから物件を送る予告（あや事例）は立てない", () => {
    const r = resolvePendingPickup(base, { now: NOW, customerWillSend: true });
    falsy(r.pending);
    eq(r.reason, "customer_will_send");
  });
  it("申込以降は立てない", () => {
    const r = resolvePendingPickup(base, { now: NOW, postApply: true });
    falsy(r.pending);
    eq(r.reason, "post_apply");
  });
  it("14日を超えた古い宣言は立てない（履行の79.8%は14日以内）", () => {
    const r = resolvePendingPickup({ ...base, pickupPromisedAt: new Date(NOW - (PENDING_PICKUP_MAX_HOURS + 1) * H).toISOString() }, { now: NOW });
    falsy(r.pending);
    eq(r.reason, "stale");
  });
  it("14日ちょうどはまだ立てる", () =>
    truthy(resolvePendingPickup({ ...base, pickupPromisedAt: new Date(NOW - PENDING_PICKUP_MAX_HOURS * H).toISOString() }, { now: NOW }).pending));
});

describe("台帳: 宣言の後に物件を送っていれば履行済み", () => {
  const ledger = buildActionLedger({
    messages: [
      { sender: "staff", text: "新着でオススメ出来るお部屋募集出次第お送りさせて頂きます！！", createdAt: "2026-09-22T01:04:00Z" },
      { sender: "staff", text: "🌟朝日プラザ 305号室\nhttps://example.com/1", createdAt: "2026-09-22T06:00:00Z" },
      { sender: "customer", text: "ありがとうございます！", createdAt: "2026-09-23T04:48:00Z" },
    ],
    now: NOW,
  });
  it("送付後は pending にしない", () => falsy(resolvePendingPickup(ledger.facts, { now: NOW }).pending));
});

// 2026-09-23 反証者の指摘: 宣言の時刻が無い時は立てない（fail-closed）
describe("宣言の時刻が分からない", () => {
  it("pickupPromisedAt=null → pending にしない（unknown_time）", () => {
    const r = resolvePendingPickup({ pickupPromisedUnfulfilled: true, pickupPromisedAt: null, lastPropertiesSentAt: null }, { now: NOW });
    falsy(r.pending); eq(r.reason, "unknown_time");
  });
  it("14日超の宣言は stale", () => {
    const r = resolvePendingPickup({ pickupPromisedUnfulfilled: true, pickupPromisedAt: new Date(NOW - (PENDING_PICKUP_MAX_HOURS + 1) * H).toISOString(), lastPropertiesSentAt: null }, { now: NOW });
    falsy(r.pending); eq(r.reason, "stale");
  });
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
