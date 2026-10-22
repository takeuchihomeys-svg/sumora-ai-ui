// AIX【物件オススメ】の2通目を竹内さんの形に寄せる出口（recommend-second-appeal・2026-10-23）
// 実行: npx tsx app/lib/__tests__/recommend-second-appeal.test.ts
import { recommendSecondAppealOn, recentAreaText, recentRequestCoversProperty, appendReceiptAfterCta, ensureRentTotalInRecommend, SECOND_RECEIPT_LINE } from "../recommend-second-appeal";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

const VIEW = "お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
const APPLY = "お気に召されましたらお申込しお部屋抑えさせて頂きます！！";

t("既定 on・off で止まる", recommendSecondAppealOn({}) && !recommendSecondAppealOn({ RECOMMEND_SECOND_APPEAL: "off" }));

// 誘導の次の行にご査収（誘導の絵文字は外す）
{
  const r = appendReceiptAfterCta(`本文です！！\n\n${VIEW}`);
  t("誘導の次にご査収を足す", r.applied === "added" && r.text.endsWith(`ご案内させて頂きます！！\n${SECOND_RECEIPT_LINE}`), r);
}
{
  const src = `本文です！！\n\n${APPLY}\n${SECOND_RECEIPT_LINE}`;
  const r = appendReceiptAfterCta(src);
  t("既にご査収がある → 何もしない", r.applied === null && r.text === src, r);
}
{
  const r = appendReceiptAfterCta(`本文です！！\n${SECOND_RECEIPT_LINE}\n\n${APPLY}`);
  t("ご査収が誘導の前 → 後へ移す", r.applied === "moved" && r.text.endsWith(`${APPLY}\n${SECOND_RECEIPT_LINE}`) && r.text.split(SECOND_RECEIPT_LINE).length === 2, r);
}
{
  const src = "本文です！！\n\nお手隙の際にご査収ください😊！！";
  t("誘導が無い（ご査収だけ）→ 何もしない", appendReceiptAfterCta(src).applied === null);
}

// 家賃管理費込は1通目の数字だけ・既に家賃がある時は足さない
{
  const r = ensureRentTotalInRecommend("2021年3月築で築年数浅く、リビング8帖、洋室4帖の使いやすい間取りで、YUMAさんにかなりオススメ出来るお部屋となります！！", 123000);
  t("オススメの文に家賃管理費込を足す", r.applied && r.text.includes("間取り・家賃管理費込123,000円で、YUMAさんにかなりオススメ出来る"), r);
}
t("合計が無い → 足さない", !ensureRentTotalInRecommend("間取りで、かなりオススメ出来るお部屋となります！！", null).applied);
t("家賃を既に書いている → 足さない", !ensureRentTotalInRecommend("家賃75,700円で、かなりオススメ出来るお部屋となります！！", 75700).applied);
t("オススメの文が無い → 足さない", !ensureRentTotalInRecommend("こちらのお部屋如何でしょうか😊！！", 75700).applied);

// 直近の会話の場所
{
  const now = Date.parse("2026-10-22T12:00:00+09:00");
  const recent = [
    { sender: "customer", text: "堀江あたりも見たいです", rawCreatedAt: "2026-10-20T10:00:00+09:00" },
    { sender: "staff", text: "承知致しました！！\n堀江周辺も含めてピックアップさせて頂きます！！", rawCreatedAt: "2026-10-20T10:10:00+09:00" },
    { sender: "customer", text: "天王寺がいいです", rawCreatedAt: "2026-09-01T10:00:00+09:00" },
    { sender: "staff", text: "🌟リンクハウス南堀江 301", rawCreatedAt: "2026-10-22T11:00:00+09:00" },
  ];
  const txt = recentAreaText(recent, now);
  t("21日より前・🌟カードは数えない", txt.includes("堀江") && !txt.includes("天王寺") && !txt.includes("リンクハウス"), txt);
  t("空の直近 → covered=false", recentRequestCoversProperty({ recentText: "", firstMessage: "x" }).covered === false);
  t("物件の駅が読めない → covered=false", recentRequestCoversProperty({ recentText: txt, firstMessage: "🌟物件 101" }).covered === false);
  const f = "🌟リンクハウス南堀江 301\n・大阪メトロ長堀鶴見緑地線「西長堀」駅徒歩5分";
  t("直近「堀江」・物件は西長堀 → ずれではない", recentRequestCoversProperty({ recentText: txt, firstMessage: f }).covered === true);
  t("直近「天王寺」→ ずれのまま", recentRequestCoversProperty({ recentText: "天王寺がいいです", firstMessage: f }).covered === false);
  t("直近「西長堀は嫌」→ ずれのまま（除外は数えない）", recentRequestCoversProperty({ recentText: "西長堀は嫌です", firstMessage: f }).covered === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
