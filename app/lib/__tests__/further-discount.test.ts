// 2026-10-08 竹内さん「物件を指さない『初期費用をもう少し抑えたいですね』は条件＝安いお部屋を探す形・このお部屋の費用を指す時だけ代表確認」（further-discount.ts）
// お客様の発言は実物（scripts/audit-further-discount-target.ts・御見積書の後 365日）
// 実行: npx tsx app/lib/__tests__/further-discount.test.ts
import { customerAsksFurtherDiscount, furtherDiscountDaihyo } from "../further-discount";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

it("9faff2ec「できれば初期費用をもう少し抑えたいですね💦 部屋は良さそうでした！」→ 代表確認にしない（竹内さんは新着の安いお部屋を送る約束）", () =>
  eq(customerAsksFurtherDiscount("できれば初期費用をもう少し抑えたいですね💦\n部屋は良さそうでした！"), false));
it("cb1a46e3「初期費用もう少し安くお願いします」→ 代表確認にしない（人はお部屋のピックアップ）", () =>
  eq(customerAsksFurtherDiscount("初期費用もう少し安くお願いします"), false));
it("cb1a46e3「これは、いつから住めますか？初期費用もう少し安くお願いします」→ 物件を指す＝代表確認", () =>
  eq(customerAsksFurtherDiscount("これは、いつから住めますか？初期費用もう少し安くお願いします"), true));
it("「このお部屋の費用をもっと抑えたい」→ 代表確認", () => eq(customerAsksFurtherDiscount("このお部屋の初期費用をもう少し抑えたいです"), true));
it("本物の割引の依頼（実物）は今まで通り代表確認", () => {
  for (const t of [
    "大成マンションの初期費用もう少し安くなりませんか？", "ここを検討中なんですが、値段もう少し安くなりませんか？", "安くなりませんかね？",
    "②のほうの物件ですがもう少し安くなりませんか？", "こちらはこれ以上安くなるのは厳しいですか？", "こちら、礼金下げることは厳しいですか🥲",
    "割引はないんですか？？他社様から304500円で提示されたんですが", "他の不動産屋さんで初期費用約10万円まで抑えられると連絡あったのですが、イエヤスさんではこれ以上抑えることは難しいですかね？",
  ]) eq(customerAsksFurtherDiscount(t), true, t);
});
it("FURTHER_DISCOUNT_POINTER=off で旧（願いの形も代表確認）", () => {
  process.env.FURTHER_DISCOUNT_POINTER = "off";
  try { eq(furtherDiscountDaihyo({ turnText: "できれば初期費用をもう少し抑えたいですね💦", estimateSent: true, postApply: false }), true); }
  finally { delete process.env.FURTHER_DISCOUNT_POINTER; }
});

// 2026-10-08 竹内さん⑥の監査（scripts/audit-further-discount-reading.ts・365日）: 旧の線から変わった 6番は全部が人の答えの側（逆向き 0）
it("取りこぼしていた依頼の言い方（人は代表・最安値で答えた）→ 代表確認", () => {
  for (const t of [
    "こちらの初期費用は抑えること厳しいですか？",
    "当初の想定より予算オーバーなので、さらに割引頑張ってもらえると助かります。",
    "こちらもう少し安い業者さんがいまして。\n\nあと審査とか関連頑張ってもらえたりしないでしようか。",
  ]) eq(customerAsksFurtherDiscount(t), true, t);
});
it("FURTHER_DISCOUNT_ASK_WIDE=off で旧（広い言い方は当てない）", () => {
  process.env.FURTHER_DISCOUNT_ASK_WIDE = "off";
  try { eq(customerAsksFurtherDiscount("こちらの初期費用は抑えること厳しいですか？"), false); }
  finally { delete process.env.FURTHER_DISCOUNT_ASK_WIDE; }
});
const EST = { sender: "staff", text: "①【伊原文化 206号室】\n\n初期費用：102,280円\n\nスモラなら一般的な不動産業者より24,520円節約出来ます！！", created_at: "2026-09-10T09:00:00Z" };
it("f5e92bc6 9/15: 御見積書の後に持ち込みの物件（URL）→「こちらはいくらくらいお安くできますか？」は代表確認にしない（人は募集状況の確認）", () => {
  const recent = [EST,
    { sender: "customer", text: "地下鉄谷町線 駒川中野 徒歩5分\n1LDK 8.5万円\n[詳細]\nhttps://myhome.nifty.com/smp/rent/osaka/xxxx/", created_at: "2026-09-15T01:27:51Z" },
    { sender: "customer", text: "こんにちは。こちらはいくらくらいお安くできますか？", created_at: "2026-09-15T01:28:53Z" }];
  eq(furtherDiscountDaihyo({ turnText: "こんにちは。こちらはいくらくらいお安くできますか？", estimateSent: true, postApply: false, recent, env: {} }), false);
  // 戻す
  eq(furtherDiscountDaihyo({ turnText: "こんにちは。こちらはいくらくらいお安くできますか？", estimateSent: true, postApply: false, recent, env: { FURTHER_DISCOUNT_NEW_PROPERTY: "off" } }), true);
});
it("f5e92bc6 9/15: ポータルの共有文（物件名：・価格：）の後の「お安くなりますか？」→ 代表確認にしない（人は御見積書）", () => {
  const recent = [EST, { sender: "customer", text: "物件名：大阪市旭区 〇〇１丁目 （太子橋今市駅 ） 2階 １ＬＤＫ\n\n物件種目：賃貸アパート\n価格：8.2万円", created_at: "2026-09-15T03:28:01Z" }];
  eq(furtherDiscountDaihyo({ turnText: "お安くなりますか？", estimateSent: true, postApply: false, recent, env: {} }), false);
});
it("1191b1eb 9/24: 持ち込みの後でも「これ以上安くなるのは厳しいですか」は見積書の金額を指す＝代表確認（人は最安値の答え）", () => {
  const recent = [{ sender: "customer", text: "https://suumo.jp/chintai/bc_0000/", created_at: "2026-09-24T08:00:00Z" }, { ...EST, created_at: "2026-09-24T09:00:53Z" },
    { sender: "customer", text: "https://suumo.jp/chintai/bc_1111/", created_at: "2026-09-24T10:00:00Z" }];
  eq(furtherDiscountDaihyo({ turnText: "こちらはこれ以上安くなるのは厳しいですか？", estimateSent: true, postApply: false, recent, env: {} }), true);
});
it("044608b4 6/11: [画像] だけの後は持ち込みと数えない（自分たちが送った物の画面写しもある）→ 代表確認のまま", () => {
  const recent = [{ sender: "staff", text: "お気に召されましたお部屋の初期費用お見積書もお送りさせていただきます😌！！", created_at: "2026-06-11T03:59:34Z" },
    { sender: "customer", text: "[画像]", created_at: "2026-06-11T08:53:52Z" }];
  eq(furtherDiscountDaihyo({ turnText: "こちらで契約させてもらえたらと思うのですが、内覧不要ですので、敷礼等お安くなりますか？", estimateSent: true, postApply: false, recent, env: {} }), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
