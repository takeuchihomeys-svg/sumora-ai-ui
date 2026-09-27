// 2026-09-27 LINE のトーク画面の「新着物件カード」（スタッフだけ）の中身
// 実行: npx tsx app/lib/__tests__/new-arrival-card.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { buildNewArrivalCards, conditionLine, roundConfirm, roundKinds, cardsBetween, pickupReviewHref, cardHeadline, auditForRound, type NacPickupRow, type NacAudit } from "../new-arrival-card";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`expected ${y} got ${x}`); }

const row = (id: number, over: Partial<NacPickupRow>): NacPickupRow => ({ id, created_at: "2026-09-27T05:41:00Z", batch_id: "b1", site: "realpro", verdict: "pass", status: "pending", seen_at: null, sent_at: null, search_mode: "pinpoint", search_override: null, complete_group_id: "cg1", ...over });
// YUMA の実物（2026-09-27 05:30 の点検の intended）
const intended = { pet_ok: false, is_wide: false, area_min: 30, rent_max: 90000, rent_min: null, area_mode: "ward", city_codes: ["27127", "27103"], floor_plan: "1K、1LDK", building_age: 25, walk_minutes: 10, station_names: [], rp_update_days: null };
const audit: NacAudit = { created_at: "2026-09-27T05:30:54Z", site: "realpro", is_wide: false, intended, customer_snapshot: { status: "hearing", rent_max: 90000 } };

it("条件の1行（区・家賃・間取り・広さ・築年・徒歩）", () => eq(conditionLine(intended), "北区・福島区／〜9万／1K・1LDK／30㎡〜／築25年／徒歩10分"));
it("更新日で絞った回は条件に出て種類は新着", () => {
  const a: NacAudit = { ...audit, intended: { ...intended, rp_update_days: 1 } };
  eq(conditionLine(a.intended)?.endsWith("更新1日以内"), true);
  eq(roundKinds([row(1, {})], a)[0], "新着");
});
it("写しに送った日が無ければ新規・あれば追加", () => {
  eq(roundKinds([row(1, {})], audit)[0], "新規");
  eq(roundKinds([row(1, {})], { ...audit, customer_snapshot: { last_property_sent_at: "2026-09-27T01:43:55Z" } })[0], "追加");
});
it("広げて（is_wide）とメモの条件の札", () => {
  const k = roundKinds([row(1, { search_mode: "widen", search_override: { x: 1 } })], { ...audit, is_wide: true });
  eq(k.includes("🔎 広げて") && k.includes("📝 メモの条件"), true);
});
it("点検は同じサイト・回より前・3時間以内の一番新しい物", () => {
  const old: NacAudit = { ...audit, created_at: "2026-09-27T01:00:00Z" };
  const other: NacAudit = { ...audit, site: "itandi", created_at: "2026-09-27T05:35:00Z" };
  eq(auditForRound([old, other, audit], "realpro", "2026-09-27T05:41:00Z")?.created_at, audit.created_at);
  eq(auditForRound([old], "realpro", "2026-09-27T05:41:00Z"), null);
});
it("確認: 通すが1件でも未読・未送信なら未確認", () => eq(roundConfirm([row(1, {}), row(2, { seen_at: "2026-09-27T06:00:00Z" })]).state, "unconfirmed"));
it("確認: 通すの全部が開いた → 確認済み（開いた）・送った行があれば送った", () => {
  eq(roundConfirm([row(1, { seen_at: "2026-09-27T06:00:00Z" }), row(2, { verdict: "hold" })]).state, "opened");
  eq(roundConfirm([row(1, { status: "sent", sent_at: "2026-09-27T07:00:00Z" }), row(2, { verdict: "hold", status: "sent" })]).state, "sent");
});
it("確認: 通す0件は none（未確認に数えない）", () => eq(roundConfirm([row(1, { verdict: "hold" })]).state, "none"));
it("まとめの回（同じ complete_group_id）は1枚・件数", () => {
  const cards = buildNewArrivalCards([row(1, {}), row(2, { verdict: "hold" }), row(3, { batch_id: "b2", created_at: "2026-09-27T05:41:14Z", verdict: "hold" })], [audit]);
  eq(cards.length, 1);
  eq([cards[0].total, cards[0].pass, cards[0].hold], [3, 1, 2]);
  eq(cards[0].at, "2026-09-27T05:41:00Z");
  eq(cardHeadline(cards[0]), "🏠 新着物件 通す 1・保留 2（リアプロ 3）");
});
it("時系列の置き場所（前の吹き出しより後・この吹き出し以前／最後の後ろ）", () => {
  const cards = [{ at: "2026-09-27T05:41:00Z" }, { at: "2026-09-27T09:00:00Z" }];
  eq(cardsBetween(cards, "2026-09-27T05:00:00Z", "2026-09-27T06:00:00Z").length, 1);
  eq(cardsBetween(cards, null, "2026-09-27T05:00:00Z").length, 0);
  eq(cardsBetween(cards, "2026-09-27T06:00:00Z", null).length, 1);
});
it("AIXツールの URL（回の最初の batch_id）", () => eq(pickupReviewHref("509cd061", "a.pdf,b.pdf"), "/conditions?pickup=509cd061&batch=a.pdf"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
