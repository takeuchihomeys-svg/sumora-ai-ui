// 2026-10-15 軸の直し③: 送った束（sent-bundles.ts）。形は実物（未桜さん 22b2511e 10/09・URL と画像の名前は伏せた）
// 実行: npx tsx app/lib/__tests__/sent-bundles.test.ts
import { buildSentBundles, bundleOfQuoted, latestBundleBefore, bundleMayAnswer, buildSentBundlesNote, textMentionsProperty } from "../sent-bundles";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const S = (id: string, at: string, o: { img?: string; text?: string }) => ({ line_message_id: id, created_at: at, sender: "staff", is_aix_generated: true, image_url: o.img ?? null, text: o.text ?? "[画像]" });
const msgs = [
  // 18:21 物件確認した（記録の物件名はエステムコート・文はレジュールアッシュ＝合わない）
  S("a1", "2026-10-09T09:21:09.224Z", { img: "u/p1.jpeg" }),
  S("a2", "2026-10-09T09:21:09.438Z", { img: "u/e1.jpeg" }),
  S("a3", "2026-10-09T09:21:09.809Z", { text: "〇〇さんお待たせしました！！\n\nレジュールアッシュ難波MINAMIの募集状況確認させて頂きました！！\n現在1番手でお申込が入っており、2番手以降でお申込可能となります！！" }),
  // 18:27 物件オススメ（資料・見積書・室内イメージの URL・🌟の文）
  S("b1", "2026-10-09T09:27:05.701Z", { img: "u/p2.jpeg" }),
  S("b2", "2026-10-09T09:27:05.869Z", { img: "u/e2.jpeg" }),
  S("b3", "2026-10-09T09:27:06.174Z", { text: "（室内イメージ）\nhttps://suumo.jp/chintai/bc_x/" }),
  S("b4", "2026-10-09T09:27:08.244Z", { text: "🌟エステムコート難波Ⅳアトリ\n\n（オススメポイント）\n・家賃60,000円" }),
];
const logs = [
  { line_message_id: "a3", sent_at: "2026-10-09T09:21:09.809Z", created_at: "2026-10-09T09:21:13Z", aix_type: "property_check_result", check_pattern: "available", property_names: ["エステムコート難波IVアトリ"], prop_statuses: ["unavailable"] },
  { line_message_id: "b4", sent_at: "2026-10-09T09:27:08.244Z", created_at: "2026-10-09T09:27:11Z", aix_type: "property_recommendation", property_names: ["エステムコート難波Ⅳアトリ"] },
];
const reads = [
  { image_url: "u/p1.jpeg", kind: "property", property_name: "エステムコート難波IVアトリ" },
  { image_url: "u/p2.jpeg", kind: "property", property_name: "エステムコート難波IVアトリ" },
];
const bundles = buildSentBundles(logs, msgs, reads);

it("文の物件名と記録が合わない AIX（18:21）は束にしない・18:27 の束だけ", () => eq(bundles.map((b) => [b.property, b.aixType]), [["エステムコート難波Ⅳアトリ", "property_recommendation"]]));
it("束に資料・見積書（名前の無い画像は物件1件の時だけ）・URL・🌟の文", () => {
  eq(bundles[0].images.map((i) => i.url), ["u/p2.jpeg", "u/e2.jpeg"]);
  eq(bundles[0].urls, ["https://suumo.jp/chintai/bc_x/"]);
  eq(bundles[0].starText?.startsWith("🌟エステムコート"), true);
});
it("「ここって洗面台とトイレ一緒？」が引用した URL の通（b3）→ その束の物件", () => eq(bundleOfQuoted(bundles, "b3")?.property, "エステムコート難波Ⅳアトリ"));
it("引用が無い時は直前の束（古い束は返さない）", () => {
  eq(latestBundleBefore(bundles, "2026-10-09T11:21:23Z")?.property, "エステムコート難波Ⅳアトリ");
  eq(latestBundleBefore(bundles, "2026-11-20T00:00:00Z"), null);
});
it("安全の線: 別の部屋・問いより前の束・募集に出ていない（空き以外の問い）は済みにしない", () => {
  const b = bundles[0];
  eq(bundleMayAnswer(b, { askedAt: "2026-10-09T09:00:00Z", property: "エステムコート難波Ⅳアトリ", nowMs: Date.parse("2026-10-09T12:00:00Z") }), true);
  eq(bundleMayAnswer(b, { askedAt: "2026-10-09T09:00:00Z", property: "レジュールアッシュ難波MINAMI", nowMs: Date.parse("2026-10-09T12:00:00Z") }), false);
  eq(bundleMayAnswer(b, { askedAt: "2026-10-09T10:00:00Z", nowMs: Date.parse("2026-10-09T12:00:00Z") }), false);
  eq(bundleMayAnswer({ ...b, status: "unavailable" }, { askedAt: "2026-10-09T09:00:00Z", about: "property_equipment", nowMs: Date.parse("2026-10-09T12:00:00Z") }), false);
});
it("材料の文に引用した束の印", () => { const n = buildSentBundlesNote(bundles, { quoted: bundles[0] }); if (!n.includes("←お客様が今引用した束") || !n.includes("室内イメージの URL 1件")) throw new Error(n); });
it("名前の揺れ（Ⅳ／IV・号室）", () => { eq(textMentionsProperty("🌟エステムコート難波IVアトリ 502号室", "エステムコート難波Ⅳアトリ"), true); eq(textMentionsProperty("レジュールアッシュ難波", "エステムコート難波Ⅳアトリ"), false); });

it("review: 1件オススメを40秒おきに続けて送った時、名前の無い画像は近い方の束だけ（窓が重なっても2つの束に入れない）", () => {
  const m2 = [
    S("x1", "2026-10-10T01:00:00.000Z", { img: "u/x.jpeg" }),
    S("x2", "2026-10-10T01:00:01.000Z", { text: "🌟グレイスカルム 201号室\n・家賃6万" }),
    S("y1", "2026-10-10T01:00:40.000Z", { img: "u/y.jpeg" }),
    S("y2", "2026-10-10T01:00:41.000Z", { text: "🌟ラモーナ出口 202号室\n・家賃5万" }),
  ];
  const l2 = [
    { line_message_id: "x2", sent_at: "2026-10-10T01:00:01.000Z", created_at: "2026-10-10T01:00:03Z", aix_type: "property_recommendation", property_names: ["グレイスカルム 201号室"] },
    { line_message_id: "y2", sent_at: "2026-10-10T01:00:41.000Z", created_at: "2026-10-10T01:00:43Z", aix_type: "property_recommendation", property_names: ["ラモーナ出口 202号室"] },
  ];
  const b2 = buildSentBundles(l2, m2, []);
  eq(b2.map((b) => [b.property, b.images.map((i) => i.url)]), [["ラモーナ出口 202号室", ["u/y.jpeg"]], ["グレイスカルム 201号室", ["u/x.jpeg"]]]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
