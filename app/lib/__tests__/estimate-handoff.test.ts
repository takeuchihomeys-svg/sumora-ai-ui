// app/lib/__tests__/estimate-handoff.test.ts
// 実行: npx tsx app/lib/__tests__/estimate-handoff.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-10-01 竹内「見積書きかれたら LINE のところに見積書のがでて押したら見積書のツールのところに連携…
//   送った物件がセットされた状態で見積書つくれるように・AD も分かるように」
// 材料は本番の実物（会話の本文はそのまま・お客様名は伏せた）。会話は scripts/try-estimate-handoff.ts --audit で読んだ物。
import {
  wantsLowInitialCostText, resolveEstimateEntry, buildEstimateHref, parseEstimateHandoff, buildEstimateReturnHref, parseEstimateReturn,
  staffPropsFromText, customerImageProp, buildHandoffEvents, selectEstimateTarget, suggestEstimateDiscount, profitLine, rentFromSummary,
  type HandoffMessage, type HandoffSentProperty, type HandoffPickup,
} from "../estimate-handoff";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}\nexpected: ${JSON.stringify(b)}\ngot:      ${JSON.stringify(a)}`); }
const noShared = () => [] as string[];
const CONV = "fb8ab8d5-5e2c-4fe5-8dc5-ad88a37c5cd3";

console.log("\n── 初期費用を抑えたい ──");
it("条件フォームの⑦「初期費用はなるべく抑えたい」", () => eq(wantsLowInitialCostText("⑦初期費用 なるべく抑えたいです"), true));
it("「敷金礼金なし希望」", () => eq(wantsLowInitialCostText("敷金礼金なし希望です"), true));
it("否定「初期費用は気にしない」は抑えたいではない", () => eq(wantsLowInitialCostText("初期費用は特に気にしないです"), false));
it("費用の質問だけ「初期費用どんな感じですか？」は抑えたいではない（実物 b380d0e3）", () => eq(wantsLowInitialCostText("初期費用どんな感じですか？"), false));

console.log("\n── 入口（どこに『見積書を作る』を出すか）──");
it("ブレインが見積書送る → estimate", () => eq(resolveEstimateEntry({ brainAction: "estimate_sheet", lowInitialCost: false }).mode, "estimate"));
it("物件オススメ＋抑えたい → with_property（同封の場面）", () => eq(resolveEstimateEntry({ brainAction: "property_recommendation", lowInitialCost: true }).mode, "with_property"));
it("物件オススメで抑えたいでない → 出さない", () => eq(resolveEstimateEntry({ brainAction: "property_recommendation", lowInitialCost: false }).show, false));
it("物件ピックアップ（複数）には出さない（30分以内の見積書 3%）", () => eq(resolveEstimateEntry({ brainAction: "property_send", lowInitialCost: true }).show, false));
it("AIX なしには出さない（物件が無い費用の質問は見積書にしない）", () => eq(resolveEstimateEntry({ brainAction: null, lowInitialCost: true }).show, false));

console.log("\n── 引き継ぎの URL ──");
it("LINE → 見積書作成", () => eq(buildEstimateHref(CONV), `/estimate?conv=${CONV}`));
it("同封の場面は scene を付ける・読み戻せる", () => eq(parseEstimateHandoff(buildEstimateHref(CONV, "with_property").split("?")[1]), { conversationId: CONV, mode: "with_property" }));
it("会話 ID でない conv は読まない", () => eq(parseEstimateHandoff("conv=abc"), null));
it("見積書作成 → LINE（Blob の画像だけ受ける）", () => {
  const url = "https://eggcrp3ajyl21x7a.public.blob.vercel-storage.com/estimates/x.png";
  eq(parseEstimateReturn(buildEstimateReturnHref(CONV, url, "estimate_sheet").split("?")[1]), { conversationId: CONV, imageUrl: url, aix: "estimate_sheet" });
});
it("よその URL は受けない", () => eq(parseEstimateReturn(`conv=${CONV}&est_img=${encodeURIComponent("https://evil.example.com/a.png")}`), null));

console.log("\n── こちらの本文・お客様の画像からお部屋 ──");
it("🌟 見出し（号室つき・実物 ad97cd40）", () => eq(staffPropsFromText("🌟グランパシフィック花園Luxe 1006号室 新着でかなり条件のいいお部屋となります！！"), [{ name: "グランパシフィック花園Luxe", room: "1006" }]));
it("🌟 見出し（号室の語なし・実物 ac34b364）", () => eq(staffPropsFromText("🌟T's Court福島 401 9月末退去予定、独立系保証会社のお部屋となります！！"), [{ name: "T's Court福島", room: "401" }]));
it("見積書の【】は名前（号室）として読む", () => eq(staffPropsFromText("【スペーシア日本橋東 608号室】\n\n初期費用さらに"), [{ name: "スペーシア日本橋東", room: "608" }]));
it("条件フォームの【】（【希望築年数】⇒）は物件にしない", () => eq(staffPropsFromText("④【希望築年数】⇒"), []));
it("お客様の画像の読み取り「物件名：CITY SPIRE桜川Ⅲ 号室名：307（3階部分）」（実物 7e2d3403）", () =>
  eq(customerImageProp("[画像] 物件種目：【住居用】マンション 物件名：CITY SPIRE桜川Ⅲ 号室名：307（3階部分） 所在地：〒556-0022"), { name: "CITY SPIRE桜川Ⅲ", room: "307" }));
it("号室名 0201 は 201", () => eq(customerImageProp("物件名：プレサンス戸原橋ヴィプラス 号室名：0201（2階部分）")?.room, "201"));

console.log("\n── どのお部屋の見積書か（実物の会話）──");
const sentRec: HandoffSentProperty[] = [{ name: "スペーシア日本橋東", room: "608", sentAt: "2026-09-12T09:19:30Z", source: "aix:property_recommendation", imageUrl: "https://x.supabase.co/a.jpg", pickupId: null }];
it("お客様がこちらの 🌟 を引用して「こちらの物件は初期費用どのくらいですか？？」→ 引用先（実物 fb8ab8d5）", () => {
  const msgs: HandoffMessage[] = [
    { sender: "staff", text: "[画像]", at: "2026-09-12T09:19:00Z", imageUrl: "https://x.supabase.co/a.jpg", lineMessageId: "L1" },
    { sender: "staff", text: "🌟スペーシア日本橋東 608号室 新着でかなり条件のいいお部屋となります！！", at: "2026-09-12T09:19:10Z", lineMessageId: "L2" },
    { sender: "staff", text: "ララプレイス難波シエールは繰り上がりのご連絡がまだ来ていない状況となります！！", at: "2026-09-12T09:27:00Z", lineMessageId: "L3" },
    { sender: "customer", text: "こちらの物件は初期費用どのくらいですか？？", at: "2026-09-12T10:38:00Z", quotedId: "L1" },
  ];
  const ev = buildHandoffEvents({ messages: msgs, sent: sentRec, sharedNamesOf: noShared });
  const c = selectEstimateTarget({ events: ev, focus: null, sent: sentRec, pickups: [], adRows: [], now: Date.parse("2026-09-12T10:40:00Z") });
  eq([c.target?.name, c.target?.source], ["スペーシア日本橋東", "customer_quoted"]);
});
it("🌟 の後に「初期費用どんな感じですか？」→ 直近の 🌟（実物 b380d0e3）", () => {
  const msgs: HandoffMessage[] = [
    { sender: "staff", text: "🌟ポーラーベアー 302号室 新着でかなり条件のいいお部屋となります！！", at: "2026-09-18T06:33:00Z" },
    { sender: "customer", text: "初期費用どんな感じですか？", at: "2026-09-18T12:00:00Z" },
  ];
  const ev = buildHandoffEvents({ messages: msgs, sent: [], sharedNamesOf: noShared });
  const c = selectEstimateTarget({ events: ev, focus: null, sent: [], pickups: [], adRows: [], now: Date.parse("2026-09-18T12:10:00Z") });
  eq([c.target?.name, c.target?.room, c.target?.source], ["ポーラーベアー", "302", "our_rec"]);
});
it("お客様が画像を3枚続けて「これの初期費用出して欲しいです」→ 持ち込みの1件目＋残りは候補（実物 7e2d3403）", () => {
  const msgs: HandoffMessage[] = [
    { sender: "customer", text: "[画像] 物件種目：【住居用】マンション 物件名：CITY SPIRE桜川Ⅲ 号室名：307（3階部分） 所在地：〒556", at: "2026-09-20T17:03:10Z", imageUrl: "https://x/1.jpg", imageType: "floor_plan" },
    { sender: "customer", text: "これの初期費用出して欲しいです", at: "2026-09-20T17:03:20Z" },
    { sender: "customer", text: "[画像] 物件種目：【住居用】マンション 物件名：プレサンス戸原橋ヴィプラス 号室名：0201（2階部分）", at: "2026-09-20T17:03:40Z", imageUrl: "https://x/2.jpg", imageType: "floor_plan" },
    { sender: "staff", text: "お送りいただきましたお部屋の御見積書作成出来次第お送りさせて頂きます！！", at: "2026-09-21T00:38:00Z" },
  ];
  const ev = buildHandoffEvents({ messages: msgs, sent: [], sharedNamesOf: noShared });
  const c = selectEstimateTarget({ events: ev, focus: null, sent: [], pickups: [], adRows: [], now: Date.parse("2026-09-21T01:50:00Z") });
  eq([c.target?.name, c.target?.source, c.target?.materials.length, c.candidates.map((x) => x.name)], ["CITY SPIRE桜川Ⅲ", "customer_brought", 1, ["プレサンス戸原橋ヴィプラス"]]);
});
it("ピックアップ（複数）の直後で名前が無い → 決めない（候補を並べる）", () => {
  const sent: HandoffSentProperty[] = [
    { name: "栄美グランドハイツ", room: "413", sentAt: "2026-09-19T03:00:00Z", source: "aix:property_send", imageUrl: null, pickupId: 1 },
    { name: "浅香山住宅5号棟", room: "503", sentAt: "2026-09-19T03:00:05Z", source: "aix:property_send", imageUrl: null, pickupId: 2 },
  ];
  const ev = buildHandoffEvents({ messages: [{ sender: "customer", text: "初期費用知りたいです", at: "2026-09-19T05:00:00Z" }], sent, sharedNamesOf: noShared });
  const c = selectEstimateTarget({ events: ev, focus: null, sent, pickups: [], adRows: [], now: Date.parse("2026-09-19T05:10:00Z") });
  eq([c.target, c.candidates.length, c.autoExtract], [null, 2, false]);
});
it("お客様が送った建物名を書いた → その建物（customer_named）", () => {
  const sent: HandoffSentProperty[] = [
    { name: "ハイツ秋桜", room: "208", sentAt: "2026-09-10T03:00:00Z", source: "aix:property_send", imageUrl: null, pickupId: null },
    { name: "昭和グランドハイツ恵美須", room: "803", sentAt: "2026-09-10T03:00:05Z", source: "aix:property_send", imageUrl: null, pickupId: null },
  ];
  const ev = buildHandoffEvents({ messages: [{ sender: "customer", text: "ハイツ秋桜の初期費用知りたいです！", at: "2026-09-10T05:00:00Z" }], sent, sharedNamesOf: noShared });
  const c = selectEstimateTarget({ events: ev, focus: null, sent, pickups: [], adRows: [], now: Date.parse("2026-09-10T05:10:00Z") });
  eq([c.target?.name, c.target?.source], ["ハイツ秋桜", "customer_named"]);
});
it("物件が何も無い → 見積書にしない（feedback_estimate_needs_property）", () => {
  const ev = buildHandoffEvents({ messages: [{ sender: "customer", text: "初期費用ってどれくらいですか", at: "2026-09-14T05:00:00Z" }], sent: [], sharedNamesOf: noShared });
  const c = selectEstimateTarget({ events: ev, focus: null, sent: [], pickups: [], adRows: [], now: Date.parse("2026-09-14T05:10:00Z") });
  eq([c.target, c.warnings.some((w) => /物件が届いた・送った・見積依頼/.test(w))], [null, true]);
});
it("共有文の前の行がお客様の文（「こちらの物件の初期費用をお伺いしたいです🙏🏻」）は名前にしない（実物 d3a56a97）", () => {
  const ev = buildHandoffEvents({
    messages: [{ sender: "customer", text: "こちらの物件の初期費用をお伺いしたいです🙏🏻\nhttps://suumo.jp/chintai/bc_1/", at: "2026-09-05T05:00:00Z" }],
    sent: [], sharedNamesOf: () => ["こちらの物件の初期費用をお伺いしたいです🙏🏻"],
  });
  const c = selectEstimateTarget({ events: ev, focus: null, sent: [], pickups: [], adRows: [], now: Date.parse("2026-09-05T05:10:00Z") });
  eq([c.target?.name, c.target?.source, c.target?.link], ["", "customer_brought", "https://suumo.jp/chintai/bc_1/"]);
});

console.log("\n── 売上サポの行（資料・AD・審査中）──");
const pick = (o: Partial<HandoffPickup>): HandoffPickup => ({ id: 2677, name: "プレミアム新福島", room: "505", sentAt: "2026-09-30T13:02:32Z", createdAt: "2026-09-30T10:40:18Z", status: "sent", adYen: 110000, rent: 55000, managementFee: 7000, adStamp: "AD 2ヶ月", adMonths: 2, dealStatus: null, pageImageUrl: "https://b.public.blob.vercel-storage.com/p.png", pdfText: "賃料 55,000 円", expired: false, ...o });
it("売上サポで送った行 → 資料の画像・文字・AD・家賃が付き、自動で読み取ってよい（実物 #2677）", () => {
  const sent: HandoffSentProperty[] = [{ name: "プレミアム新福島", room: "505", sentAt: "2026-09-30T13:02:40Z", source: "aix:property_recommendation", imageUrl: null, pickupId: 2677 }];
  const ev = buildHandoffEvents({ messages: [], sent, sharedNamesOf: noShared });
  const c = selectEstimateTarget({ events: ev, focus: null, sent, pickups: [pick({})], adRows: [], now: Date.parse("2026-09-30T14:00:00Z") });
  eq([c.target?.adYen, c.target?.adMonths, c.target?.rent, c.target?.materials[0]?.kind, !!c.target?.materialText, c.autoExtract], [110000, 2, 55000, "pickup_page", true, true]);
});
it("資料の現況が審査中 → 警告・自動で読み取らない", () => {
  const sent: HandoffSentProperty[] = [{ name: "プレミアム新福島", room: "505", sentAt: "2026-09-30T13:02:40Z", source: "aix:property_recommendation", imageUrl: null, pickupId: 2677 }];
  const ev = buildHandoffEvents({ messages: [], sent, sharedNamesOf: noShared });
  const c = selectEstimateTarget({ events: ev, focus: null, sent, pickups: [pick({ dealStatus: "審査中" })], adRows: [], now: Date.parse("2026-09-30T14:00:00Z") });
  eq([c.autoExtract, c.warnings.some((w) => /審査中/.test(w))], [false, true]);
});
it("売上サポに無い物件は送付の記録（共有の行）の AD を使う", () => {
  const sent: HandoffSentProperty[] = [{ name: "アコード中之島", room: "1402", sentAt: "2026-09-22T01:00:00Z", source: "aix:property_recommendation", imageUrl: "https://x/s.jpg", pickupId: null }];
  const ev = buildHandoffEvents({ messages: [], sent, sharedNamesOf: noShared });
  const c = selectEstimateTarget({ events: ev, focus: null, sent, pickups: [], adRows: [{ name: "アコード中之島", room: "1402", adMonths: 2, adYen: null, rent: 64000, at: "2026-09-21T10:00:00Z" }], now: Date.parse("2026-09-22T02:00:00Z") });
  eq([c.target?.adYen, c.target?.adSource, c.target?.materials[0]?.kind], [128000, "sent", "sent_image"]);
});

console.log("\n── 割引の目安 ──");
it("前の見積書が無い → 家賃×0.54ヶ月（55,000 → 30,000）", () => eq(suggestEstimateDiscount({ rent: 55000, adYen: 110000 })?.yen, 30000));
it("家賃が分かる時は前の割引（別のお部屋）を目安にせず参考に並べる（YUMA: 前の割引 124,050円・家賃 65,000円）", () => {
  const r = suggestEstimateDiscount({ rent: 65000, adYen: 65000, pastDiscounts: [124050] });
  eq([r?.yen, r?.pastMedianYen, r?.warning], [35000, 124050, null]);
});
it("家賃が分からない時は前の割引の中央値", () => eq(suggestEstimateDiscount({ rent: null, pastDiscounts: [33000, 38000, 41000] })?.yen, 38000));
it("目安が AD を超えたら警告", () => eq(!!suggestEstimateDiscount({ rent: 120000, adYen: 50000 })?.warning, true));
it("家賃も前の割引も無い → 出さない", () => eq(suggestEstimateDiscount({ rent: null }), null));
it("利益の一言", () => eq(profitLine(110000, 30000), "AD 110,000円 − 割引 30,000円 ＝ 利益 80,000円"));
it("summary_text の家賃・管理費（「55,000円 7,000円」）", () => eq(rentFromSummary("【18】プレミアム新福島 505号室\n55,000円 7,000円\n1K 19.83㎡"), { rent: 55000, managementFee: 7000 }));

console.log(`\n${passed} passed / ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
