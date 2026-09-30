// 実行: npx tsx app/lib/__tests__/second-message-exit.test.ts
// 2026-09-30 YUMA の実送信テスト（AIX【物件オススメ】→ 2通目のテンプレート）で実際に LINE に届いた文をそのまま使う。
//   ① 作業メモ・渡した指示の復唱が届いた（回1・回3） ② 1通目と別の物件の話になった（回2・回4）
import { foreignRoomsInSecond, readFirstMessage } from "../aix-chain-note";
import { isNotACustomerReply, stripMetaNarration } from "../meta-narration";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

const FIRST_SWISS = "🌟SWISS梅田東 307\n\n敷金礼金なし・家賃管理費込88,000円の好条件で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にごゆっくりご確認ください😊！！";
const FIRST_GO = "🌟Ｇｏ　Ｐａｌａｃｅ　Ｆｕｋｕｓｈｉｍａ 203号室\n\n敷金礼金なし・家賃管理費込72,500円とYUMAさんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にごゆっくりご確認ください😊！！";
const FIRST_ESLEAD = "🌟エスリードレジデンス大阪福島フロント 0205\n\n敷金礼金なし・家賃管理費込85,000円で初期費用をかなり抑えてご入居頂ける点が、YUMAさんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にご査収ください😊！！";
const FIRST_FEEL = "🌟FEEL UMEDA (フィールウメダ) 202\n\n家賃管理費込66,000円・堺筋線「扇町」駅徒歩7分で、YUMAさんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にごゆっくりご確認ください😊！！";

const SECOND_R1 = "【2通目】お客様が選びやすい形で、ひとこと添える。今の条件（エリア・家賃・間取り）に合う点を1つだけ挙げて、返事が軽くできる一文で締める。ここでは新しい金額・日程・物件名を足さない。";
const SECOND_R2 = "ファーストフィオーレ難波ウエスト901号室は家賃管理費込75,000円の角部屋で、2018年築と築浅ですが、Ｇｏ　Ｐａｌａｃｅ　Ｆｕｋｕｓｈｉｍａ203号室は72,500円と、こちらの方が毎月の負担を抑えられます！！\n\n敷金礼金なしで初期費用も抑えられますので、私個人的にはこちらがオススメです😊！！\n\n気になる点があれば、いつでもお気軽にご連絡ください😌！！";
const SECOND_R3 = "LINEのトーク画面で送られたメッセージには、YUMAさんが2通目を受け取る文脈は含まれていますが、こちらに表示された履歴では、直前の送付物と2通目の方向性しか確認できません。ここまでのやり取りを踏まえて、橋渡し文を書きます。\n\n---\n\nエスリードレジデンス大阪福島フロント0205号室は、ご希望の北区・福島区エリアで2023年築と築浅ですので、お送りした中でも特にオススメしたいお部屋です！！\n\n保証会社など審査面のご不安があれば先にお調べしますので、気になる点はいつでもお気軽にご連絡ください😌！！";
const SECOND_R4 = "Ｇｏ　Ｐａｌａｃｅ　Ｆｕｋｕｓｈｉｍａ203号室は家賃管理費込72,500円で敷金礼金なし、2017年築の角部屋とお値打ちな条件なので、私個人的にはこちらがオススメです😊！！\n\nお気に召されましたらご都合よろしいお日にちにご案内させて頂きます😌！！";

console.log("\n■ 1通目から物件が読めるか（全角の名前・括弧つきの名前・号室の語が無い形）");
{
  t("SWISS梅田東 307", readFirstMessage(FIRST_SWISS).propertyLabels.some((l) => l.endsWith("307号室")));
  t("Ｇｏ　Ｐａｌａｃｅ　Ｆｕｋｕｓｈｉｍａ 203号室（全角・全角の空白）", readFirstMessage(FIRST_GO).propertyLabels.some((l) => l.endsWith("203号室")), JSON.stringify(readFirstMessage(FIRST_GO).propertyLabels));
  t("エスリードレジデンス大阪福島フロント 0205（先頭 0）", readFirstMessage(FIRST_ESLEAD).propertyLabels.some((l) => l.endsWith("0205号室")), JSON.stringify(readFirstMessage(FIRST_ESLEAD).propertyLabels));
  t("FEEL UMEDA (フィールウメダ) 202（括弧つき）", readFirstMessage(FIRST_FEEL).propertyLabels.some((l) => l.endsWith("202号室")), JSON.stringify(readFirstMessage(FIRST_FEEL).propertyLabels));
}

console.log("\n■ foreignRoomsInSecond（1通目に無い号室＝別の物件）");
{
  t("★ 回2: 1通目 203号室 → 2通目に 901号室（ファーストフィオーレ）", JSON.stringify(foreignRoomsInSecond(SECOND_R2, FIRST_GO)) === '["901"]', JSON.stringify(foreignRoomsInSecond(SECOND_R2, FIRST_GO)));
  t("★ 回4: 1通目 202 → 2通目は 203号室（前の回の物件）", JSON.stringify(foreignRoomsInSecond(SECOND_R4, FIRST_FEEL)) === '["203"]', JSON.stringify(foreignRoomsInSecond(SECOND_R4, FIRST_FEEL)));
  t("同じ物件の話は通す（0205 と 0205号室）", foreignRoomsInSecond("エスリードレジデンス大阪福島フロント0205号室は2023年築と築浅です！！", FIRST_ESLEAD).length === 0);
  t("先頭の 0 の有無は同じ部屋（0205 と 205号室）", foreignRoomsInSecond("205号室は築浅でオススメです😊！！", FIRST_ESLEAD).length === 0);
  t("全角の数字も同じ部屋", foreignRoomsInSecond("２０３号室は角部屋です！！", FIRST_GO).length === 0);
  t("号室に触れない2通目は通す", foreignRoomsInSecond("気になる点があれば、いつでもお気軽にご連絡ください😌！！", FIRST_GO).length === 0);
  t("1通目から物件が読めない時は見ない", foreignRoomsInSecond(SECOND_R2, "お部屋ピックアップさせて頂きました😊！！").length === 0);
  t("1通目が無い時は見ない", foreignRoomsInSecond(SECOND_R2, null).length === 0);
  t("金額・年は号室と読まない（72,500円・2017年築）", foreignRoomsInSecond("家賃管理費込72,500円で2017年築の角部屋です！！", FIRST_GO).length === 0);
}

console.log("\n■ 作業メモ・指示の復唱");
{
  t("★ 回1: 「【2通目】…ひとこと添える。」は返信ではない", isNotACustomerReply(SECOND_R1));
  const r3 = stripMetaNarration(SECOND_R3);
  t("★ 回3: 先頭の作業メモと区切り線を落とし、本文だけ残る", r3.removed.length > 0 && r3.text.startsWith("エスリードレジデンス大阪福島フロント0205号室は") && !/橋渡し|---/.test(r3.text), r3.text.slice(0, 60));
  t("回3: 落とした後の本文は返信として通る", !isNotACustomerReply(r3.text));
  t("普通の2通目は触らない", stripMetaNarration("気になる点があれば、いつでもお気軽にご連絡ください😌！！").removed.length === 0 && !isNotACustomerReply("気になる点があれば、いつでもお気軽にご連絡ください😌！！"));
  t("1通目（物件オススメの本文）は返信として通る", !isNotACustomerReply(FIRST_GO) && stripMetaNarration(FIRST_GO).removed.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
