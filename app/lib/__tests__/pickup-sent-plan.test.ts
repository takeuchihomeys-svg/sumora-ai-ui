// 売上サポ「📤 AIXで送る」→ sent_properties に何を書くか（planPickupSentWrites）のテスト（2026-09-24）
// 実行: npx tsx app/lib/__tests__/pickup-sent-plan.test.ts（全 PASS で exit 0）
import { planPickupSentWrites, type PickupForRecord, type ExistingSentRow } from "../pickup-sent-plan";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

const NOW = "2026-09-24T05:00:00.000Z";
const P = (id: number, rank: number, name: string, room: string | null, img: string | null, ad: number | null = null): PickupForRecord =>
  ({ id, rank, property_name: name, room_no: room, ad_yen: ad, trim_image_url: null, page_image_url: img });
const E = (o: Partial<ExistingSentRow> & { id: string }): ExistingSentRow =>
  ({ property_name: null, room_no: null, image_url: null, source: null, delivery: null, channel: null, pickup_id: null, sent_at: NOW, ad_yen: null, ...o });
const base = { conversationId: "conv1", propertyCustomerId: "pc1", now: NOW };

console.log("── 画像の数が合う時は位置で対応させて insert ──");
{
  const r = planPickupSentWrites({
    ...base,
    pickups: [P(2, 2, "コル・デ・ソル杭全", "0203", "p2.jpg"), P(1, 1, "小路東一戸建", "101号室", "p1.jpg", 50000)],
    deliveredImageUrls: ["sent-a.jpg", "sent-b.jpg"],
    existing: [],
  });
  const a = r.inserts[0], b = r.inserts[1];
  t("2行 insert", r.inserts.length === 2 && r.updates.length === 0, r);
  t("rank 順に画像を対応（rank1 → 1枚目）", a.pickup_id === 1 && a.image_url === "sent-a.jpg" && b.image_url === "sent-b.jpg", r.inserts);
  t("channel=pickup・delivery=customer・source=aix:property_send", a.channel === "pickup" && a.delivery === "customer" && a.source === "aix:property_send");
  t("ad_yen が入る・property_url は null", a.ad_yen === 50000 && a.property_url === null);
  t("号室は正規化（0203→203・101号室→101）", b.room_no === "203" && a.room_no === "101", r.inserts);
  t("sent_image_properties の行も2つ（channel=pickup）", r.imageRows.length === 2 && r.imageRows.every((x) => x.channel === "pickup"));
  t("会話と物件顧客が入る", a.conversation_id === "conv1" && a.property_customer_id === "pc1");
}
{
  const r = planPickupSentWrites({ ...base, pickups: [P(1, 1, "A荘", "101", "p1.jpg"), P(2, 2, "B荘", "102", "p2.jpg")], deliveredImageUrls: ["x.jpg"], existing: [] });
  t("数が合わない → 何も書かず全件 image_count_mismatch", r.inserts.length === 0 && r.updates.length === 0 && r.imageRows.length === 0
    && r.skipped.length === 2 && r.skipped.every((s) => s.reason === "image_count_mismatch"), r);
}
{
  const r = planPickupSentWrites({ ...base, pickups: [P(1, 1, "A荘", "101", "p1.jpg"), P(2, 2, "B荘", "102", "p2.jpg")], deliveredImageUrls: null, existing: [] });
  t("deliveredImageUrls が null → 画像なしで全件 insert", r.inserts.length === 2 && r.inserts.every((x) => x.image_url === null) && r.imageRows.length === 0, r);
}
{
  const r = planPickupSentWrites({ ...base, pickups: [P(1, 1, "A荘", "101", null), P(2, 2, "B荘", "102", null)], deliveredImageUrls: [], existing: [] });
  t("画像の無い pickup だけで配列が空 → 全件 insert", r.inserts.length === 2 && r.skipped.length === 0, r);
}

console.log("── 冪等・合流 ──");
{
  const r = planPickupSentWrites({ ...base, pickups: [P(1, 1, "A荘", "101", "p1.jpg")], deliveredImageUrls: ["s1.jpg"], existing: [E({ id: "e1", property_name: "A荘", room_no: "101", source: "aix:property_send", pickup_id: 1 })] });
  t("同じ pickup_id の行があれば already", r.inserts.length === 0 && r.updates.length === 0 && r.skipped[0]?.reason === "already", r);
}
{
  const r = planPickupSentWrites({
    ...base, pickups: [P(3, 1, "YUMAテスト荘参番館", "301", "p3.jpg", 30000)], deliveredImageUrls: ["s3.jpg"],
    existing: [E({ id: "v1", property_name: "読み違い名", room_no: "", image_url: "s3.jpg", source: "vision", sent_at: "2026-09-24T04:59:30Z" })],
  });
  const u = r.updates[0];
  t("読み取りが先に書いた行（同じ画像・vision）→ update で合流", r.inserts.length === 0 && u?.id === "v1", r);
  t("source を aix:property_send・channel を pickup・pickup_id を付ける", u?.patch.source === "aix:property_send" && u?.patch.channel === "pickup" && u?.patch.pickup_id === 3 && u?.patch.ad_yen === 30000, u);
  t("image_url は既にあるので触らない", !("image_url" in (u?.patch ?? {})));
}
{
  const r = planPickupSentWrites({
    ...base, pickups: [P(4, 1, "フォルモント寺田町", "304", "p4.jpg")], deliveredImageUrls: ["s4.jpg"],
    existing: [E({ id: "v2", property_name: "フォルモント寺田町", room_no: "304", image_url: "other.jpg", source: "vision", sent_at: "2026-09-24T03:30:00Z" })],
  });
  t("同じ物件で2時間以内（1.5時間前・経路不明の vision）→ 合流", r.updates[0]?.id === "v2" && r.inserts.length === 0, r);
}
{
  const r = planPickupSentWrites({
    ...base, pickups: [P(4, 1, "フォルモント寺田町", "304", "p4.jpg")], deliveredImageUrls: ["s4.jpg"],
    existing: [E({ id: "v2s", property_name: "フォルモント寺田町", room_no: "304", image_url: "other.jpg", source: "staff_image", sent_at: "2026-09-24T03:30:00Z" })],
  });
  t("手動で送った画像（staff_image・別の画像）には名前で合流しない → insert", r.inserts.length === 1 && r.updates.length === 0, r);
}

console.log("── 経路の取り違えを起こさない（2026-09-24 反証）──");
{
  const r = planPickupSentWrites({
    ...base, pickups: [P(7, 1, "○○ハイツ", "101", "p7.jpg")], deliveredImageUrls: ["s7.jpg"],
    existing: [
      E({ id: "rec", property_name: "○○ハイツ", room_no: "101", image_url: "rec.jpg", source: "aix:property_recommendation", sent_at: "2026-09-24T04:00:00Z" }),
      E({ id: "chk", property_name: "○○ハイツ", room_no: "101", image_url: "chk.jpg", source: "vision", channel: "check", sent_at: "2026-09-24T04:10:00Z" }),
    ],
  });
  t("オススメ・物件確認の行が2時間以内にあっても合流せず insert", r.inserts.length === 1 && r.updates.length === 0, r);
  t("オススメの行は channel=recommendation のまま（patch が当たらない）", !r.updates.some((u) => u.id === "rec" || u.id === "chk"));
}
{
  const r = planPickupSentWrites({
    ...base, pickups: [P(8, 1, "△△荘", "202", "p8.jpg")], deliveredImageUrls: ["s8.jpg"],
    existing: [E({ id: "same", property_name: "読み違い", room_no: "", image_url: "s8.jpg", source: "vision", channel: "recommendation", sent_at: NOW })],
  });
  const u = r.updates[0];
  t("同じ画像の行には合流するが、付いている経路（recommendation）は上書きしない", u?.id === "same" && !("channel" in (u?.patch ?? {})) && !("source" in (u?.patch ?? {})) && u?.patch.pickup_id === 8, r);
}
{
  const r = planPickupSentWrites({
    ...base, pickups: [P(9, 1, "□□館", "303", "p9.jpg")], deliveredImageUrls: ["s9.jpg"],
    existing: [E({ id: "pk", property_name: "□□館", room_no: "303", image_url: "old.jpg", source: "vision", channel: "pickup", sent_at: "2026-09-24T04:30:00Z" })],
  });
  t("経路 pickup の行（読み取りが先に書いた）には名前で合流する", r.updates[0]?.id === "pk" && r.inserts.length === 0, r);
}
{
  const r = planPickupSentWrites({
    ...base, pickups: [P(4, 1, "フォルモント寺田町", "304", "p4.jpg")], deliveredImageUrls: ["s4.jpg"],
    existing: [E({ id: "v3", property_name: "フォルモント寺田町", room_no: "304", image_url: "other.jpg", source: "vision", sent_at: "2026-09-24T02:00:00Z" })],
  });
  t("同じ物件でも3時間前なら insert（昔の送付に合流しない）", r.inserts.length === 1 && r.updates.length === 0, r);
}
{
  const r = planPickupSentWrites({
    ...base, pickups: [P(5, 1, "コル・デ・ソル杭全", "101", "p5.jpg")], deliveredImageUrls: ["s5.jpg"],
    existing: [
      E({ id: "g1", property_name: "コル・デ・ソル杭全", room_no: "", source: "line_group", delivery: "shared", sent_at: NOW }),
      E({ id: "o1", property_name: "小路東一戸建", room_no: "101", source: "vision", sent_at: NOW }),
    ],
  });
  t("同じ物件の line_group（共有）の行には合流せず insert（共有と送付は別の行）", r.inserts.length === 1 && r.updates.length === 0, r);
  t("号室が同じでも別物件（小路東一戸建 101）には合流しない", !r.updates.some((u) => u.id === "o1"));
}
{
  const r = planPickupSentWrites({
    ...base, pickups: [P(6, 1, "A荘", "101", "p6.jpg")], deliveredImageUrls: ["s6.jpg"],
    existing: [E({ id: "z", property_name: "A荘", room_no: "101", image_url: "s6.jpg", source: "aix:property_send", pickup_id: 99 })],
  });
  t("別の pickup_id が付いた行には合流しない（insert）", r.inserts.length === 1 && r.updates.length === 0, r);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
