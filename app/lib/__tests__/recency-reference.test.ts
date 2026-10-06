// app/lib/__tests__/recency-reference.test.ts
// 2026-10-06 竹内（見木 響夢さん）「先程ってかなり前にやり取りしていた物件なので、そこも踏まえて考える」
//   近さの言葉（先ほど・先程・さっき）で前の物件を指すのは、前の物件のやり取りから3時間以内だけ。古い時は語を「以前」に（スタッフの言い方）
// 実行: npx tsx app/lib/__tests__/recency-reference.test.ts
import { lastRoomExchange, fixRecentReference, hasRecentRoomRef, buildRecencyNote, recentReferenceOk } from "../recency-reference";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }

// ── 実物（見木さん・10/04 22:14 の生成）
const now = Date.parse("2026-10-04T13:14:49Z");
const MIKI = [
  { sender: "staff", text: "見木さんお世話になっております！！ お送り頂きました物件、確認させて頂きましたところ現在募集中となっております！！", created_at: "2026-09-28T03:44:18Z" },
  { sender: "customer", text: "ここっていつまで待って貰えそうですか？", created_at: "2026-09-28T04:02:48Z" },
  { sender: "customer", text: "結構早めに埋まっちゃいそうですかね💦", created_at: "2026-10-01T13:40:54Z" },
  { sender: "staff", text: "響夢さん お世話になっております！！ 家賃がかなり安いお部屋となりますので…募集サイト掲載中のお部屋は206号室のみとなります", created_at: "2026-10-02T01:16:04Z" },
  { sender: "staff", text: "[画像]", created_at: "2026-10-04T13:14:30Z" },
  { sender: "staff", text: "🌟シャトレー小松里 202\n\n1件新着で響夢さんにかなりオススメ出来るお部屋が募集に出ました！！", created_at: "2026-10-04T13:14:39Z" },
];
const MIKI_GEN = "響夢さん お世話になっております！！\n\n先ほどのお部屋とは別にお送りさせて頂きました！！\n\n家賃管理費込29,000円で、毎月の費用をかなり抑えられるお部屋となっております！！\n\nお手隙の際にご査収ください😊！！";
const last = lastRoomExchange(MIKI, now);
t("見木: 今の通（画像・🌟）は数えず、前の物件のやり取りは2日半前（スタッフ）", !!last && Math.round(last.hours) === 60 && last.by === "staff", JSON.stringify(last));
t("見木: 近さの言葉は使えない", recentReferenceOk(last) === false);
{
  const r = fixRecentReference(MIKI_GEN, last);
  t("見木: 比べるだけの行が外れる", r.text === "響夢さん お世話になっております！！\n\n家賃管理費込29,000円で、毎月の費用をかなり抑えられるお部屋となっております！！\n\nお手隙の際にご査収ください😊！！", r.text);
  t("見木: applied", r.applied.includes("recent_compare_line"));
}
t("見木: 生成に渡す時系列の1行に「2日前（10/2）」と使わない言葉", /3日前|2日前/.test(buildRecencyNote(last, now)) && /10\/2/.test(buildRecencyNote(last, now)) && /指さない/.test(buildRecencyNote(last, now)), buildRecencyNote(last, now));

// ── 語だけ替える（全件監査の実物）
const OLD = { hours: 486, by: "staff" as const };
t("「先ほどお送りしました〇〇」→ 以前お送りしました", fixRecentReference("しんさんお世話になっております！！\n先ほどお送りしましたエステムプラザ心斎橋EAST Ⅳ ブランディア 5階部分が、", OLD).text.includes("以前お送りしましたエステムプラザ"));
t("「先ほどの物件は」→ 以前お送りさせて頂きました物件は", fixRecentReference("先ほどの物件は空室がない状況でしたが、", { hours: 26.7, by: "staff" }).text.startsWith("以前お送りさせて頂きました物件は空室がない"));
t("お客様が送った物件 →「以前お送り頂きました物件」", fixRecentReference("先ほどの物件は募集終了となります", { hours: 30, by: "customer" }).text.startsWith("以前お送り頂きました物件は"));

// ── 触らない物（誤って直さない）
t("3時間以内は直さない", fixRecentReference("モモカさん\n先ほどお気に召されたお部屋が現在募集に出ておりませんでしたので、", { hours: 2.2, by: "staff" }).applied.length === 0);
t("分からない（null）は直さない", fixRecentReference(MIKI_GEN, null).applied.length === 0);
t("先ほどはお電話 は物件ではない", !hasRecentRoomRef("先ほどはお電話ありがとうございました😊！！"));
t("先ほどお送りした項目（条件の記入欄）は物件ではない", !hasRecentRoomRef("先ほどお送りした項目の中でも、まずは②ご希望家賃・③ご希望間取り"));
t("先ほどの記入欄 は物件ではない", !hasRecentRoomRef("先ほどの記入欄にご入力頂き、代理契約者様と"));
t("先程募集に出たばかりのお部屋（掲載の時刻）は直さない", !hasRecentRoomRef("🌟CRASTINE大蓮北4丁目A202号室は先程募集に出たばかりの今月末退去予定のお部屋となります！！"));
t("古くても お電話 は直さない", fixRecentReference("先ほどはお電話ありがとうございました！！", OLD).applied.length === 0);
// 今の通の🌟だけで、前の物件のやり取りが無い → 分からない
t("前のやり取りが無い → null", lastRoomExchange([{ sender: "staff", text: "🌟A 101", created_at: "2026-10-04T13:14:39Z" }], now) === null);

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
