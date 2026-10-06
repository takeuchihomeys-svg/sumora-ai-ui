// app/lib/__tests__/estimate-pickup-entry.test.ts
// 実行: npx tsx app/lib/__tests__/estimate-pickup-entry.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-10-06 竹内「AIXツール 物件ごとに見積書作成のボタンをつける それを押すと見積書と連携して作成できるようにする」
//   物件の札（property_pickups の1行）→ /estimate?conv=…&pickup=<id> → その行のお部屋で開く（estimate-handoff の targetFromPickup・applyPickedPickup）
//   材料はスクショ（会話「R」の札: AD 124,000円・302号室・敷金/礼金 なし・保証金/償却 なし・131点）に合わせた形（物件名は伏せた）
import {
  buildEstimateHref, parseEstimateHandoff, buildHandoffEvents, selectEstimateTarget, targetFromPickup, applyPickedPickup,
  type HandoffPickup, type HandoffSentProperty,
} from "../estimate-handoff";
import { linkAdForEstimate, type AdSource } from "../estimate-profit";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}\nexpected: ${JSON.stringify(b)}\ngot:      ${JSON.stringify(a)}`); }
const CONV = "fb8ab8d5-5e2c-4fe5-8dc5-ad88a37c5cd3";
const noShared = () => [] as string[];

const pick = (o: Partial<HandoffPickup>): HandoffPickup => ({
  id: 9101, name: "テストレジデンス福島", room: "302", sentAt: null, createdAt: "2026-10-06T01:00:00Z", status: "pending",
  adYen: 124000, rent: 62000, managementFee: 8000, adStamp: "AD 2ヶ月", adMonths: 2, dealStatus: null,
  pageImageUrl: "https://b.public.blob.vercel-storage.com/p302.png", pdfText: "賃料 62,000 円 管理費 8,000 円 敷金 なし 礼金 なし", expired: false,
  termsLine: "💴 敷0/礼0 築5年 入居:相談", ...o,
});

console.log("\n── 札 → 見積書作成の URL ──");
it("pickup を付ける・読み戻せる", () => eq(parseEstimateHandoff(buildEstimateHref(CONV, "estimate", { pickupId: 9101 }).split("?")[1]), { conversationId: CONV, mode: "estimate", pickupId: 9101 }));
it("URL は会話と id だけ（物件名・家賃・お客様名を載せない）", () => eq(buildEstimateHref(CONV, "estimate", { pickupId: 9101 }), `/estimate?conv=${CONV}&pickup=9101`));
it("pickup が無い時は今まで通り（キーを足さない）", () => eq(parseEstimateHandoff(`conv=${CONV}`), { conversationId: CONV, mode: "estimate" }));
it("数字でない pickup は読まない", () => eq(parseEstimateHandoff(`conv=${CONV}&pickup=1;drop`)?.pickupId, undefined));
it("0・負の id は付けない", () => eq(buildEstimateHref(CONV, "estimate", { pickupId: 0 }), `/estimate?conv=${CONV}`));

console.log("\n── 札の行のお部屋 ──");
it("その行の資料・文字・家賃・管理費・AD・募集の条件をそのまま（推測で足さない）", () => {
  const t = targetFromPickup(pick({}));
  eq([t.source, t.name, t.room, t.pickupId, t.rent, t.managementFee, t.adYen, t.adMonths, t.adSource, t.materials.map((m) => m.kind), !!t.materialText, t.termsLine],
    ["staff_pickup", "テストレジデンス福島", "302", 9101, 62000, 8000, 124000, 2, "pickup", ["pickup_page"], true, "💴 敷0/礼0 築5年 入居:相談"]);
});
it("行に AD が無い時だけ送付の記録の AD を寄せる", () => {
  const t = targetFromPickup(pick({ adYen: null, adMonths: null, adStamp: null }), [{ name: "テストレジデンス福島", room: "302", adMonths: 1.5, adYen: null, rent: 62000, at: "2026-10-05T00:00:00Z" }]);
  eq([t.adYen, t.adMonths, t.adSource], [93000, 1.5, "sent"]);
});
it("家賃が読めない行は空のまま（0 や推測で埋めない）", () => {
  const t = targetFromPickup(pick({ rent: null, managementFee: null, adYen: null, adMonths: null, adStamp: null }));
  eq([t.rent, t.managementFee, t.adYen, t.adMonths], [null, null, null, null]);
});

console.log("\n── 自動の選びを札のお部屋に差し替える ──");
// 直近の回で2件送った（自動は決めずに候補）→ 札で 302 を押した
const sent: HandoffSentProperty[] = [
  { name: "別館ハイツ", room: "201", sentAt: "2026-10-05T03:00:00Z", source: "aix:property_send", imageUrl: "https://x/a.jpg", pickupId: 9001 },
  { name: "テストレジデンス福島", room: "302", sentAt: "2026-10-05T03:00:10Z", source: "aix:property_send", imageUrl: "https://x/b.jpg", pickupId: 9101 },
];
const now = Date.parse("2026-10-06T02:00:00Z");
const auto = selectEstimateTarget({ events: buildHandoffEvents({ messages: [], sent, sharedNamesOf: noShared }), focus: null, sent, pickups: [pick({})], adRows: [], now });
it("（前提）自動は2件の回で決めない＝候補だけ", () => eq([auto.target, auto.candidates.length, auto.autoExtract], [null, 2, false]));
it("札のお部屋が対象・AI 読み取りまで進めてよい・回の警告は消える", () => {
  const c = applyPickedPickup(auto, targetFromPickup(pick({})));
  eq([c.target?.source, c.target?.room, c.autoExtract, c.warnings.some((w) => /2件お送り/.test(w))], ["staff_pickup", "302", true, false]);
});
it("自動の候補は選び直しに残す（同じお部屋は重ねない）", () => {
  const c = applyPickedPickup(auto, targetFromPickup(pick({})));
  eq(c.candidates.map((x) => `${x.name} ${x.room}`), ["別館ハイツ 201"]);
});
it("自動で選んでいた別のお部屋は候補に下げる", () => {
  const focusAuto = selectEstimateTarget({ events: [], focus: { name: "別館ハイツ 201", building: "別館ハイツ", room: "201", sentByUs: true, status: "sent", statusLabel: "送付済み", customerInterest: false }, sent: [], pickups: [], adRows: [], now });
  const c = applyPickedPickup(focusAuto, targetFromPickup(pick({})));
  eq([c.target?.name, c.candidates[0]?.name, c.candidates[0]?.source], ["テストレジデンス福島", "別館ハイツ", "candidate"]);
});
it("主のお部屋と違う時は警告だけ（札のお部屋を使う）", () => {
  const c = applyPickedPickup(auto, targetFromPickup(pick({})), { name: "別館ハイツ 201", building: "別館ハイツ", room: "201", sentByUs: true, status: "sent", statusLabel: "送付済み", customerInterest: false });
  eq([c.target?.name, c.warnings.some((w) => /主のお部屋/.test(w))], ["テストレジデンス福島", true]);
});
it("審査中の資料 → 警告・自動で読み取らない（今の止め方のまま）", () => {
  const c = applyPickedPickup(auto, targetFromPickup(pick({ dealStatus: "審査中" })));
  eq([c.autoExtract, c.warnings.some((w) => /審査中/.test(w))], [false, true]);
});
it("資料も文字も無い（保存期間切れ）→ 警告・自動で読み取らない", () => {
  const c = applyPickedPickup(auto, targetFromPickup(pick({ pageImageUrl: null, pdfText: null })));
  eq([c.autoExtract, c.warnings.some((w) => /資料の画像がありません/.test(w))], [false, true]);
});
it("AD が分からない → 警告", () => {
  const c = applyPickedPickup(auto, targetFromPickup(pick({ adYen: null, adMonths: null, adStamp: null })));
  eq(c.warnings.some((w) => /AD が分かりません/.test(w)), true);
});

console.log("\n── 送った見積書と売上サポの行の AD を結ぶ（estimate_records）──");
const item = { index: 0, propertyName: "テストレジデンス福島", roomNo: "302", discountYen: 40000, initialCostYen: 150000 };
it("候補プール・送付記録に無い（まだ送っていない札の部屋）→ 売上サポの行の AD", () => {
  const l = linkAdForEstimate(item, [{ kind: "pickup", name: "テストレジデンス福島", roomNo: "302", adYen: 124000, adMonths: null, rent: 62000, at: "2026-10-06T01:00:00Z" }]);
  eq([l?.source, l?.adYen, l?.rent], ["pickup", 124000, 62000]);
});
it("送付記録があればそちらが先（今までの結び方を変えない）", () => {
  const src: AdSource[] = [
    { kind: "pickup", name: "テストレジデンス福島", roomNo: "302", adYen: 124000, rent: 62000 },
    { kind: "sent_property", name: "テストレジデンス福島", roomNo: "302", adMonths: 1.5, rent: 62000 },
  ];
  eq(linkAdForEstimate(item, src)?.source, "sent_property");
});
it("号室が違う売上サポの行は使わない", () => eq(linkAdForEstimate(item, [{ kind: "pickup", name: "テストレジデンス福島", roomNo: "805", adYen: 124000, rent: 62000 }]), null));

console.log(`\n${passed} passed / ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
