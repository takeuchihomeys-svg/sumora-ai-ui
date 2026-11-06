// 2026-11-06 作業員1（型3・q354・q356・q357）: 謝り・断り・締めの後のお礼を動く番と読まない読み方と一手
// 実行: npx tsx app/lib/__tests__/sorry-decline-read.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { sorryDeclineReadOn, readSorryDecline, pickSorryDeclineExamples, sorryDeclineBrainText } from "../sorry-decline-read";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`); }
}
function expect<T>(a: T) { return { toBe: (b: T) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }, toContain: (s: string) => { if (!String(a).includes(s)) throw new Error(`expected to contain ${s}`); } }; }

it("スイッチは既定 on（止める =off）", () => { expect(sorryDeclineReadOn({})).toBe(true); expect(sorryDeclineReadOn({ BRAIN_SORRY_DECLINE_READ: "off" })).toBe(false); });
// 当たる実物
it("q356 前の方が好き・申し訳ない → 謝り・断り", () => { expect(readSorryDecline({ customerText: "ここも良いんですが、前の方が好きです😥\nせっかくなのに申し訳ございません" })).toBe("sorry_decline"); });
it("q357 申込はしなくても大丈夫・お手数おかけします → 謝り・断り", () => { expect(readSorryDecline({ customerText: "確認ありがとうございます。\n焦って決めたくはないため申し込みはしなくても大丈夫です！\nお手数おかけします🙇" })).toBe("sorry_decline"); });
it("q354 締めの後のお礼 → 締めの後のお礼", () => { expect(readSorryDecline({ customerText: "ご丁寧に有難うございます(ぴえん)(ぴえん)", prevStaffText: "はい😊！！\nごゆっくりご検討いただけますと幸いです！！\nお気に召されましたらご案内させていただきますので、いつでもお気軽にご連絡ください😌！！" })).toBe("thanks_after_closing"); });
it("実物 a3cc571e 6畳は狭すぎるので大丈夫です → 謝り・断り", () => { expect(readSorryDecline({ customerText: "6畳はせますぎるので大丈夫ですすいません" })).toBe("sorry_decline"); });
it("実物 db3722a5 今回は見送り → 謝り・断り", () => { expect(readSorryDecline({ customerText: "申し訳ありません。\n\n転勤の件無くなりましたので今回は見送りでお願いします。" })).toBe("sorry_decline"); });
// 当たらない実物（同じ発言で新しい依頼・質問・決める話）
for (const [name, t] of [
  ["330ad233 すみません他お願いします", "すみません他お願いします。"],
  ["969f0162 すみません この二つ空いてますか", "すみません。この二つ空いてますか。"],
  ["d8691e41 相見積してごめんなさい", "何回も相見積してごめんなさい\n他社がこれを提示してきてて…"],
  ["f2196d11 スモラさんで契約させていただこうと思います", "返信遅くなってしまい申し訳ありません🙇‍♀️他社にも相談していたのですがスモラさんで契約させていただこうと思います、遅れてすみません"],
  ["d46290ff 今日中には決めたい", "色々すいません\n今日中には決めたいと思います。\nよろしくお願いします🙇"],
  ["d99ab7e6 早めにお願いいたします", "先程もお送りした通り他店でも同時進行してるので早めにお願いいたします\n無理をいって申し訳ございません"],
  ["0133b787 申し訳ございませんが他の物件をお願い致します", "この物件は前に住んでた大国住宅の前にありますので申し訳ございませんが他の物件をお願い致します。"],
  ["a64dbdd1 もう一度探していただけませんでしょうか", "申し訳ないのですが、今回2ldkで探してまして\nもう一度探していただけませんでしょうか(>_<)"],
  // 監査（90日）で謝りの語だけで当たっていた実物＝外す
  ["9faff2ec すみませんよろしくお願いします（この後に物件の AIX）", "すみませんよろしくお願いします🙇‍♀️"],
  ["331b0338 こちらも合わせてお願いします 何度もすいません", "こちらも合わせてお願いします！\n何度もすいません！"],
  ["9280fa49 5分ほど遅れてしまいそう 申し訳", "5分ほど遅れてしまいそうです。\n大変申し訳御座いません。"],
  ["62d01e33 10/5 12:00~お願いしたい 遅くなり申し訳", "お世話になっております！\n遅くなり申し訳ないです💦\n\n10/5(月)12:00~お願いしたいです！"],
  ["da5548d7 審査がとおるかが不安", "申し訳ないのですが、審査がとおるかが不安です…\n過去に色々ありまして…"],
  ["5752c0d1 一旦電話は大丈夫です", "一旦電話は大丈夫です"],
  ["f568a14b 物件ありますでしょうか 何度もすみません", "何度もすみません💦\n我孫子駅か長居駅で1Kからでいいので、広めで綺麗で安めの物件ありますでしょうか"],
  ["db3722a5 敷金礼金無しでお願いします（条件）", "ありがとうございます。\n\n敷金礼金無しでお願いします。"],
] as const) it(`当たらない実物: ${name}`, () => { expect(readSorryDecline({ customerText: t })).toBe(null); });
it("監査で当たる実物: 8590144d 家賃が範囲外・無しでお願い", () => { expect(readSorryDecline({ customerText: "2件とも家賃が範囲外ですので、せっかくご提案していただいたのですが無しでお願い致します🙇‍♂️" })).toBe("sorry_decline"); });
it("監査で当たる実物: 8b5a777e 今回はやめておきます", () => { expect(readSorryDecline({ customerText: "ありがとうございます！\nそちらの物件拝見しましたが\n今回はやめておきます🙇🏻‍♀️💦" })).toBe("sorry_decline"); });
it("締めの後でも問いのあるお礼は当たらない（84b560f4 保証会社はどこになりますでしょうか）", () => { expect(readSorryDecline({ customerText: "ありがとうございます！\nこちらの保証会社はどこになりますでしょうか。", prevStaffText: "ごゆっくりご検討ください！！" })).toBe(null); });
it("締めではない文の後のお礼は当たらない（約束の後のお礼は別の線）", () => { expect(readSorryDecline({ customerText: "ありがとうございます！", prevStaffText: "募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！" })).toBe(null); });
it("手本: 同じ会話（q356）は外す", () => { expect(pickSorryDeclineExamples("a260169b-7491-41fe-9c3a-fbd860326fca", {}).some((e) => e.conv.startsWith("a260169b"))).toBe(false); });
it("手本: 試験の元の会話も外す", () => { expect(pickSorryDeclineExamples("copy", { BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV: "a260169b-7491-41fe-9c3a-fbd860326fca" }).length).toBe(2); });
it("材料の文: 謝り・断りは読み方と一手の1組", () => {
  const t = sorryDeclineBrainText("sorry_decline", pickSorryDeclineExamples("x", {}));
  expect(t).toContain("動く依頼ではない");
  expect(t).toContain("一手: 竹内さんは受け止めの返信");
  expect(t).toContain("内覧の誘い・申込の誘いにしない");
});
it("材料の文: 締めの後のお礼は返さないにしない", () => { expect(sorryDeclineBrainText("thanks_after_closing", [])).toContain("返さないにしない"); });
it("材料の文: 当たらなければ空", () => { expect(sorryDeclineBrainText(null, [])).toBe(""); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
