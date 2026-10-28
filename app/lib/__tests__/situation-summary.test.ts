// 統括の②状況のまとめ「今すぐ果たせる物」（2026-10-29）
// 実行: npx tsx app/lib/__tests__/situation-summary.test.ts
import { nowFulfillableEnabled, nowFulfillableLine, buildSituationSummary } from "../situation-summary";
import type { RoomState } from "../customer-state";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const NOW = Date.parse("2026-10-29T03:00:00Z");
const room = (o: Partial<RoomState> & { name: string; events: RoomState["events"] }): RoomState => ({
  key: o.name, building: o.name, room: null, status: "candidate", statusLabel: "候補", vacating: false, estimateSent: false, customerInterest: false,
  sentByUs: true, firstAt: o.events[0]?.at ?? "", lastAt: o.events.at(-1)?.at ?? "", maybeSameAs: [], ...o,
});

it("既定 off", () => { eq(nowFulfillableEnabled({}), false); eq(nowFulfillableEnabled({ SITUATION_NOW_FULFILLABLE: "on" }), true); });
it("送った物件（2日前）＝確認済み・見積を作れる／持ち込み＝確認が要る／見積済み", () => {
  const t = nowFulfillableLine({ nowMs: NOW, pickupReady: false, rooms: [
    room({ name: "Tio Verde 302", events: [{ kind: "sent", at: "2026-10-27T03:00:00Z", source: "x" }] }),
    room({ name: "アーバネックス堺筋本町 701", sentByUs: false, events: [{ kind: "customer_shared", at: "2026-10-28T03:00:00Z", source: "x" }] }),
    room({ name: "シーズンフラッツ 204", estimateSent: true, status: "estimate_sent", events: [{ kind: "sent", at: "2026-10-20T03:00:00Z", source: "x" }, { kind: "estimate", at: "2026-10-21T03:00:00Z", source: "x" }] }),
  ] });
  ok(/確認済み（今も募集中と分かっている）: Tio Verde 302/.test(t), t);
  ok(/見積を作れる（確認済み・見積まだ）: Tio Verde 302/.test(t), t);
  ok(/見積済み: シーズンフラッツ 204/.test(t), t);
  ok(/確認が要る[^:]*: アーバネックス堺筋本町 701/.test(t) && /送れる新しい候補: なし/.test(t), t);
});
it("終了・申込中のお部屋は出さない・何も無ければ空", () => {
  eq(nowFulfillableLine({ nowMs: NOW, pickupReady: null, rooms: [room({ name: "終わった部屋", status: "ended", events: [{ kind: "sent", at: "2026-10-28T03:00:00Z", source: "x" }] })] }), "");
});

it("状況のまとめの型: 段階・開いている約束（pending だけ）・気持ち・今すぐ果たせる物・指している送った事", () => {
  const s = buildSituationSummary({
    state: { stage: "proposing" as never, stageLabel: "提案中", properties: [room({ name: "Tio Verde 302", events: [{ kind: "sent", at: "2026-10-27T03:00:00Z", source: "x" }] })] },
    promises: [
      { kind: "check", action: "property_check_result", checkPattern: null, object: "アーバネックス", evidence: "確認させて頂きます", promisedAt: "2026-10-28T03:00:00Z", status: "pending", doneAt: null, doneBy: null },
      { kind: "estimate", action: "estimate_sheet", checkPattern: null, object: null, evidence: "御見積書お送り", promisedAt: "2026-10-27T03:00:00Z", status: "done", doneAt: "2026-10-27T05:00:00Z", doneBy: "AIX" },
    ] as never,
    emotion: { value: "前向き", source: "brain" } as never, bind: null, pickupReady: false, nowMs: NOW,
  });
  eq(s.openPromises.map((p) => p.kind), ["check"]);
  eq(s.nowFulfillable.confirmed, ["Tio Verde 302"]);
  eq([s.stage, s.bind, s.nowFulfillable.pickupReady], ["proposing", null, false]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
