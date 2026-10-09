// 2026-10-08 竹内さん①: 来られない事情のお客様への「オンライン内見や、室内の撮影もご対応させて頂きます😊！！」を最終チェックが落とさない（final-check-viewing-offer.ts）
// お客様の発言・人の文は実物（scripts/audit-viewing-offer-final-check.ts・365日・名前は伏せ字）
// 実行: npx tsx app/lib/__tests__/final-check-viewing-offer.test.ts
import { isViewingOfferSentence, customerCannotCome, photoOfferExempt, isViewingOfferFlag } from "../final-check-viewing-offer";
import { runVocabSemanticChecks } from "../final-check";
import { ONLINE_VIEWING_LINE } from "../customer-circumstances";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const TRIP = "内覧したいのですが、現在出張中のため、そちらへ伺うことができません";
const DRAFT = `〇〇さんお世話になっております！！\nかしこまりました！！\nお気に召されましたらお申込みでお部屋を抑えた状態で、ご都合よろしいお日にちにご内覧頂けます！！\n${ONLINE_VIEWING_LINE}`;
const photoCodes = (text: string, cust: string, env?: string) => {
  if (env) process.env.FINAL_CHECK_VIEWING_OFFER = env;
  try {
    return runVocabSemanticChecks(text, { lastCustomerMessage: cust, recentMessages: [{ sender: "staff", text: "🌟エスリード〇〇 1406号室\n\nお手隙の際にご査収ください😌！！" }, { sender: "customer", text: cust }] })
      .filter((i) => /^PHOTO_/.test(i.code)).map((i) => i.code);
  } finally { delete process.env.FINAL_CHECK_VIEWING_OFFER; }
};

it("申し出の文（竹内さんの形 3つ）", () => {
  for (const s of [ONLINE_VIEWING_LINE, "オンライン内見や、室内撮影も行わせていただきます！！", "〇〇さんお気に召されたお部屋を一度弊社撮影またはオンライン内見をさせて頂き", "一度室内撮影しお送りさせて頂きます😊！！", "〇〇1406号室の室内写真・動画を撮影しお送りさせて頂きます！！"]) eq(isViewingOfferSentence(s), true, s);
});
it("申し出ではない文（撮影済み・送った・日時）", () => {
  for (const s of ["〇〇801号室の室内写真と動画撮影しお送りさせていただきました！！", "明日 9/7 16:00〜よりオンライン内見させて頂きます！！", "撮影したお写真お送りさせて頂きます"]) eq(isViewingOfferSentence(s), false, s);
});
it("来られない事情（出張中・広島在住・予定詰まって・〇日以降・海外）", () => {
  for (const t of [TRIP, "今が広島に住んでいて、内見が難しい状況なのですが", "今月前半結構予定詰まってて🥲", "内覧したいんですが都合つくのが9月13日以降の予定なんですが", "あと海外にいて収入証明がないのですが"]) eq(customerCannotCome(t), true, t);
  for (const t of ["こちら内見したいです", "明日の13時いけますか？"]) eq(customerCannotCome(t), false, t);
});
it("YUMA trip_now: 出張中の「内覧したい」への申し出に PHOTO_REPLACES_VIEWING／PHOTO_NO_PREMISE を出さない", () => eq(photoCodes(DRAFT, TRIP), []));
it("FINAL_CHECK_VIEWING_OFFER=off で旧（落としていた）", () => eq(photoCodes(DRAFT, TRIP, "off").sort(), ["PHOTO_NO_PREMISE", "PHOTO_REPLACES_VIEWING"]));
it("事情なしの「内覧したい」を撮影に置き換える文は今まで通り止める", () =>
  eq(photoCodes("かしこまりました！！\n室内撮影しお送りさせて頂きます！！", "こちら内見したいです"), ["PHOTO_NO_PREMISE", "PHOTO_REPLACES_VIEWING"]));
it("事情があっても撮影済みの言い切り（AIX の番）は外さない", () =>
  eq(photoOfferExempt("室内写真と動画撮影しお送りさせていただきました！！", TRIP), false));
it("LLM の AIX_BOUNDARY_PROMISE が申し出の文だけを引用 → 外す／会社の制度の捏造（FABRICATED_POLICY）も外す／事情なし・他の型・他の文は外さない", () => {
  eq(isViewingOfferFlag("AIX_BOUNDARY_PROMISE", "オンライン内見や、室内の撮影もご対応させて頂きます", DRAFT, TRIP), true);
  eq(isViewingOfferFlag("AIX_BOUNDARY_PROMISE", "オンライン内見や、室内の撮影もご対応させて頂きます", DRAFT, "こちら内見したいです"), false);
  eq(isViewingOfferFlag("FABRICATED_POLICY", "オンライン内見や、室内の撮影もご対応させて頂きます", DRAFT, TRIP), true);
  eq(isViewingOfferFlag("FABRICATED_AMOUNT", "オンライン内見や、室内の撮影もご対応させて頂きます", DRAFT, TRIP), false);
  eq(isViewingOfferFlag("AIX_BOUNDARY_PROMISE", "お申込みでお部屋を抑えた状態で", DRAFT, TRIP), false);
  eq(isViewingOfferFlag("AIX_BOUNDARY_PROMISE", "オンライン内見や、室内の撮影もご対応させて頂きます", DRAFT, TRIP, { FINAL_CHECK_VIEWING_OFFER: "off" }), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
