// 2026-09-27 LINE のトーク画面の「新着物件カード」（スタッフだけ）の中身
// 実行: npx tsx app/lib/__tests__/new-arrival-card.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { buildNewArrivalCards, conditionLine, roundConfirm, roundRecommend, roundKinds, cardsBetween, pickupReviewHref, cardHeadline, auditForRound, stampLine, roundTarget, type NacPickupRow, type NacAudit } from "../new-arrival-card";

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
  // 2026-10-01: 写しに送った日が無い回＝新規 → 見出しは「初回の物件」（旧は種類を見ず全部「新着物件」）
  eq(cardHeadline(cards[0]), "🏠 初回の物件 通す 1・保留 2（リアプロ 3）");
  eq(cardHeadline({ ...cards[0], kind: "新着" }), "🏠 新着物件 通す 1・保留 2（リアプロ 3）");
});

// 2026-10-01 竹内（チンシャン・初回）: リアプロのピンポイント 9:02（1件）→ 自動の広げて 9:08（12件）。ITANDI は検索していない。通す1・保留10・外す候補2
it("チンシャン: 印は リアプロ 🎯済 🔎済 ｜ ITANDI 🎯未 🔎未・見出しは初回・目安10件に あと9件", () => {
  const snap = { status: "hearing", rent_max: 100000 };
  const auds: NacAudit[] = [
    { created_at: "2026-10-01T00:02:36Z", site: "realpro", is_wide: false, intended: { rent_max: 100000, rent_min: 70000, floor_plan: "2LDK", rp_update_days: null }, customer_snapshot: snap },
    { created_at: "2026-10-01T00:08:35Z", site: "realpro", is_wide: true, intended: { rent_max: 105000, rent_min: 70000, floor_plan: "2LDK", rp_update_days: null }, customer_snapshot: snap },
  ];
  const rows: NacPickupRow[] = [
    row(1, { created_at: "2026-10-01T00:03:09Z", batch_id: "p1", verdict: "hold", search_mode: "pinpoint", complete_group_id: "cgC" }),
    row(2, { created_at: "2026-10-01T00:09:30Z", batch_id: "w1", verdict: "pass", search_mode: "widen", complete_group_id: "cgC" }),
    ...Array.from({ length: 9 }, (_, i) => row(3 + i, { created_at: "2026-10-01T00:09:30Z", batch_id: "w1", verdict: "hold", search_mode: "widen", complete_group_id: "cgC" })),
    row(20, { created_at: "2026-10-01T00:09:31Z", batch_id: "w2", verdict: "drop", search_mode: "widen", complete_group_id: "cgC" }),
    row(21, { created_at: "2026-10-01T00:09:31Z", batch_id: "w2", verdict: "drop", search_mode: "widen", complete_group_id: "cgC" }),
  ];
  const cards = buildNewArrivalCards(rows, auds);
  eq(cards.length, 1);
  const c = cards[0];
  eq([c.pass, c.hold, c.drop], [1, 10, 2]);
  eq(c.kind, "新規");
  eq(stampLine(c.stamps ?? []), "リアプロ 🎯✅ 🔎✅ ｜ ITANDI 🎯➖ 🔎➖");
  eq([c.target?.need, c.target?.short], [10, 9]);
  eq(cardHeadline(c).startsWith("🏠 初回の物件 通す 1"), true);
});
it("新着は1件で足りる（目安1件・不足0）", () => {
  eq(roundTarget("新着", 1)?.short, 0);
  eq(roundTarget("追加", 0), null);
});
it("時系列の置き場所（前の吹き出しより後・この吹き出し以前／最後の後ろ）", () => {
  const cards = [{ at: "2026-09-27T05:41:00Z" }, { at: "2026-09-27T09:00:00Z" }];
  eq(cardsBetween(cards, "2026-09-27T05:00:00Z", "2026-09-27T06:00:00Z").length, 1);
  eq(cardsBetween(cards, null, "2026-09-27T05:00:00Z").length, 0);
  eq(cardsBetween(cards, "2026-09-27T06:00:00Z", null).length, 1);
});
it("AIXツールの URL（回の最初の batch_id）", () => eq(pickupReviewHref("509cd061", "a.pdf,b.pdf"), "/conditions?pickup=509cd061&batch=a.pdf"));

// 2026-09-27 竹内「新着物件もオススメだけは資料も表示／物件ピックアップは件数が表示されていればよい」
it("物件オススメ: 通すが1件の回はその物件（資料の画像＝trim_image_url）", () => {
  const r = roundRecommend([row(1, { property_name: "ルミエール福島", room_no: "302", trim_image_url: "https://x/t.png" }), row(2, { verdict: "hold" })]);
  eq(r, { id: 1, name: "ルミエール福島", room_no: "302", image: "https://x/t.png" });
});
it("物件オススメ: 画像が無ければ image=null（物件名だけ）", () => eq(roundRecommend([row(1, { property_name: "A" })])?.image, null));
it("物件ピックアップ（通す2件以上）は null＝件数だけ", () => eq(roundRecommend([row(1, {}), row(2, {})]), null));
it("送った回は送った件数で決める（1件だけ送った＝物件オススメ・その1件）", () => {
  eq(roundRecommend([row(1, {}), row(2, { status: "sent", property_name: "B" }), row(3, {})])?.id, 2);
  eq(roundRecommend([row(1, { verdict: "pass", status: "sent" }), row(2, { status: "sent" })]), null);
});
it("通す0件の回は null", () => eq(roundRecommend([row(1, { verdict: "hold" })]), null));
it("カードに recommend が入る", () => eq(buildNewArrivalCards([row(1, { property_name: "C" })], [audit])[0].recommend?.name, "C"));
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
