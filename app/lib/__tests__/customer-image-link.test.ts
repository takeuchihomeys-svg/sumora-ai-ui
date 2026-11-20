// 2026-11-15 作業員H: お客様の画像の結び付け（customer-image-link.ts・CUSTOMER_IMAGE_LINK）のテスト。
//   元の番の形（14日の本番の書き起こしの形・名前と番号は架空に置き換えた）で、画像→結び付け→ブレインの材料の1行→決まりの材料（道の候補）までを通す。LLM も DB も使わない。
// 実行: npx tsx app/lib/__tests__/customer-image-link.test.ts
import { readFileSync } from "node:fs";
import { linkCustomerImage, linkTurnImages, buildImageLinkBlock, estimateFactsFromTranscript, asksOf, reactedSentProperties, customerImageLinkOn, type SentForLink } from "../customer-image-link";

// 2026-11-20 作業員K2: CUSTOMER_IMAGE_ROUTE_1115 が既定 on になった＝このファイルは結び付けの前の行き先（route off）を確かめる
process.env.CUSTOMER_IMAGE_ROUTE_1115 = "off";
let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

const SENT: SentForLink[] = [
  { name: "サンプラザ照ヶ丘1棟", room: "404", sentAt: "2026-11-05T03:00:00Z", rent: 47000, bundleNo: 2, bundlePos: 3 },
  { name: "プレサンス難波EASTモダニティ", room: "805", sentAt: "2026-11-05T03:00:30Z", rent: 62000, bundleNo: 2, bundlePos: 4 },
];
// c0b8c696 11/06 の形（物件の資料・名前と号室あり）
const MATERIAL = "[画像] 【物件の資料】\n物件種目 マンション\n物件名：サンプラザ照ヶ丘1棟\n号室名 404\n賃料 4.7万円 管理費 3,000円\n1DK 22.5㎡\n地下鉄谷町線 喜連瓜破駅 徒歩2分\n築35年\n取引態様 仲介";
// 84b560f4 11/02 の形（ポータル・名前なし）
const PORTAL = "[画像] 【物件の画面（ポータル）】\nLIFULL HOME'S\n賃料 6.86万円\n管理費 8,000円\n1K 25.73㎡\n大阪メトロ中央線 阿波座駅 徒歩3分\n築8年\nお問い合わせ";
// 3d2b1f6a 11/11 の形（他社の見積書・宛名つき）
const OTHER_EST = "[画像] 【見積書・初期費用の明細】\n見積書\n2026/10/30\nタツヤ　様\n物件名：サンプル日本橋　502号室\n家賃　¥63,000\n共益費　¥8,000\n礼金　¥63,000\n敷金　-\n保証会社代　¥35,500\n火災保険代　¥15,000\n鍵交換代　¥27,500\n仲介手数料　¥0\n合計　¥221,800\nサンプル不動産株式会社";
const OWN_EST = "[画像] 【見積書・初期費用の明細】\n御見積書\nこの度は、蓮産業株式会社を御利用頂き誠に有り難うございました。\n御請求金額 ¥248,300\n物件名：サンプル日本橋\n敷金：0\n礼金：63,000\n火災保険：15,000\n鍵交換：27,500";
// 3d2b1f6a 11/04 の形（号室の一覧の資料を Vision が見積と分けた）
const LISTING_AS_EST = "[画像] 【見積書・初期費用の明細】\n詳細(特約等)\n※鍵交換代:30,000円(税別)\n| 号室 | 現況 | 間取/専有面積 | 敷金 | 礼金 | 家賃 |\n| 405 | R中 | 1K 22.23㎡ | 0円 | 0円 | 58,000円 |\n合計 2";

ok("既定 on（2026-11-20）・off で止める", customerImageLinkOn({}) === true && customerImageLinkOn({ CUSTOMER_IMAGE_LINK: "off" }) === false);
{
  const l = linkCustomerImage({ text: MATERIAL, at: "2026-11-06T04:02:00Z", customerWords: "こちらの物件気になってます 一旦内見して決めたい", sent: SENT });
  ok("資料: 物件名・号室（確かさ high）", l.kind === "property_material" && l.property?.name === "サンプラザ照ヶ丘1棟" && l.property?.room === "404" && l.property?.certainty === "high", JSON.stringify(l.property));
  ok("送った物件と照合: 2回目の送信の3件目・同じ部屋", l.ours?.by === "same_room" && l.ours.bundleNo === 2 && l.ours.bundlePos === 3 && l.relation === "reaction_to_ours", JSON.stringify(l.ours));
  ok("募集状況は手元にある（送った時に確認済み）", l.vacancyOnHand === "sent_confirmed");
  ok("聞いている事: 内覧・好み", l.asks.includes("viewing") && l.asks.includes("like"));
  ok("行き先: 送った物件で内覧＝ AIX【内覧調整】（約束を挟まない・KB）", /内覧調整/.test(l.route.text) && !!l.route.kb);
}
{
  const l = linkCustomerImage({ text: PORTAL, at: "2026-11-02T12:09:00Z", customerWords: "", sent: SENT });
  ok("ポータル・名前なし: 値は取る・確かさ mid・新しい持ち込み", l.kind === "property_screen" && l.property?.rentYen === 68600 && l.property.station === "阿波座" && l.property.certainty === "mid" && l.relation === "new_brought", JSON.stringify(l));
  ok("一言なしの持ち込み: 募集状況＋最大限割引の御見積書の約束（acda2b5c）", /一言が無い持ち込み/.test(l.route.text) && /acda2b5c/.test(l.route.kb ?? ""));
  ok("家賃だけでは送った物件と照らさない", l.ours === null);
}
{
  const l = linkCustomerImage({ text: PORTAL, at: "2026-11-02T12:09:00Z", customerWords: "こういうお部屋で探してほしいです", sent: SENT });
  ok("「こういう」は好みの手本（決まっていない）", l.relation === "similar_other" && /決まっていない/.test(l.route.text));
  const l2 = linkCustomerImage({ text: PORTAL, at: "2026-11-02T12:09:00Z", customerWords: "この物件は申し込めますでしょうか", sent: SENT });
  ok("「申し込めますか」は空きを聞く持ち込み（好みの手本にしない）", l2.relation === "new_brought" && l2.asks.includes("vacancy"));
}
{
  const l = linkCustomerImage({ text: OTHER_EST, at: "2026-11-11T14:56:00Z", customerWords: "", sent: SENT });
  ok("他社の見積書: 会社・内訳（敷0・礼6.3万・保証3.55万・鍵2.75万・火災1.5万・総額22.18万）", l.kind === "estimate_other" && l.estimate?.items.total === 221800 && l.estimate.items.key_money === 63000 && l.estimate.items.deposit === 0 && l.estimate.items.guarantee === 35500 && l.estimate.companyName === "サンプル不動産株式会社", JSON.stringify(l.estimate));
  ok("行き先: 相見積もり（87ff68e1）", /相見積もり/.test(l.route.text) && /87ff68e1/.test(l.route.kb ?? ""));
  const block = buildImageLinkBlock([l]);
  ok("材料の行に宛名（お客様の名前）を入れない", !/タツヤ/.test(block) && /総額22\.18万円/.test(block), block);
}
{
  const l = linkCustomerImage({ text: OWN_EST, at: "2026-11-11T14:56:00Z", customerWords: "以前これで貰ったんですけど差額の方どうなりますか？", sent: SENT });
  ok("弊社の見積書（蓮産業）・行き先は決まっていない", l.kind === "estimate_own" && l.estimate?.companyName === "弊社" && /決まっていない/.test(l.route.text));
  const ls = linkCustomerImage({ text: LISTING_AS_EST, at: "2026-11-04T03:39:00Z", customerWords: "", sent: SENT });
  ok("号室の一覧の資料（Vision が見積と分けた）は見積書と読まない", ls.kind === "property_material" && ls.estimate === null, JSON.stringify({ k: ls.kind, e: ls.estimate }));
}
{
  ok("書類は種類だけ", linkCustomerImage({ text: "[画像] 本人確認書類", imageType: "id_document", at: "2026-11-12T00:00:00Z", sent: [] }).kind === "document");
  ok("物件以外は物件の理由にしない", /物件以外/.test(linkCustomerImage({ text: "[画像] 【物件以外：振込・支払いの控え】", at: "2026-11-12T00:00:00Z", sent: [] }).route.text));
  const u = linkCustomerImage({ text: "[画像] 【物件の画面（ポータル）】\nお気に入り\n最近見た物件", at: "2026-11-08T04:38:00Z", sent: SENT });
  ok("物件が引けない画像は人に回す（needsStaff）", u.needsStaff && u.relation === "unknown");
}
{
  // 連投の束: 画像2枚＋一言（84b560f4 11/02 12:09 の形）
  const turn = [
    { text: PORTAL, created_at: "2026-11-06T12:09:00Z" },
    { text: MATERIAL, created_at: "2026-11-06T12:09:20Z" },
    { text: "こちらの物件も合わせて2件お願いします🙇‍♂️", created_at: "2026-11-06T12:10:00Z" },
  ];
  const links = linkTurnImages(turn, SENT);
  ok("束の順（1/2・2/2）と一言の共有", links.length === 2 && links[0].burst.index === 1 && links[1].burst.size === 2 && links.every((l) => /2件お願いします/.test(l.words ?? "")));
  const block = buildImageLinkBlock(links);
  ok("材料のブロック: 2枚目は送った物件（2回目の送信の3件目）", /1\/2枚目/.test(block) && /2回目の送信の3件目/.test(block), block);
}
ok("⑤ 送った物件のどれに反応したか（一言の物件名）", reactedSentProperties("サンプラザ照ヶ丘の方が気になります", SENT).map((s) => s.name).join() === "サンプラザ照ヶ丘1棟");
ok("向き: 空き・費用・比べ", asksOf("ここまだ空いてますか").includes("vacancy") && asksOf("初期費用いくらですか").includes("cost") && asksOf("他社より安くなりますか").includes("compare"));
ok("見積と言えない書き起こしは null", estimateFactsFromTranscript("家賃 6.3万円 管理費 8,000円") === null);
{
  const bc = readFileSync("app/lib/brain-core.ts", "utf8");
  ok("配線: brain-core が今の連投の画像を結び付けて送った物件の一覧の後に足す（off の時は読まない）", /customerImageLinkOn\(\)/.test(bc) && /buildImageLinkBlock\(customerImageLinks\)/.test(bc) && /ref_needs_name/.test(bc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
