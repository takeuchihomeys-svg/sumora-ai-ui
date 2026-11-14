// 2026-11-15 作業員H: 返信後の反応の記録（reply_engagement_signals.customer_reply_text）の個人の値を伏せる（engagement-text-mask・ENGAGEMENT_TEXT_MASK）
//   元の形（記入済みの申込フォーム・欄の名前の無い値の並び）を架空の値で。LLM も DB も使わない。
// 実行: npx tsx app/lib/__tests__/engagement-text-mask.test.ts
import { maskEngagementText, engagementTextMaskOn, isApplicationLikeText } from "../engagement-text-mask";
import { altPiiSignal } from "../alt-pii-gate";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

const FORM = "【お申込者様記入欄】\n・入居希望日 11/20\n・氏名、フリガナ 山田花子 ヤマダハナコ\n・生年月日 1995/03/12\n・現住所 〒530-0001 大阪府大阪市北区架空町1-2-3\n・住居年数 2年\n・住居形態賃貸\n・携帯番号 090-1234-5678\n・メールアドレス hanako@example.com\n・勤務先名 架空株式会社\n・年収 300万\n・駐輪場利用の有無（台数）1台";
const PASTE = "山田太郎ヤマダタロウ\n1985.9.9\n岡山県岡山市中区架空66-11\n08012345678\n母";
ok("既定 on", engagementTextMaskOn({}) && !engagementTextMaskOn({ ENGAGEMENT_TEXT_MASK: "off" }));
{
  const m = maskEngagementText(FORM);
  ok("記入済みの申込フォーム: 個人の値は〇〇・欄の名前は残す", !/山田|ヤマダ|1995|架空|090|example|300万|賃貸/.test(m) && /・年収 〇〇/.test(m) && /・携帯番号 〇〇/.test(m), m);
  ok("入居希望日・駐輪場の行は残す", /入居希望日 11\/20/.test(m) && /駐輪場利用の有無（台数）1台/.test(m));
  ok("伏せた後に出口の網に当たる値が残らない", altPiiSignal(m) === null);
}
{
  const m = maskEngagementText(PASTE);
  ok("欄の名前の無い値の並べ（住所・電話）も申込の形と読み、行ごと〇〇", isApplicationLikeText(PASTE) && !/山田|ヤマダ|1985|岡山|080/.test(m), m);
}
ok("普通の返信はそのまま", maskEngagementText("ありがとうございます！内覧は11月20日でお願いします") === "ありがとうございます！内覧は11月20日でお願いします");
ok("URL の中の数字は電話にしない", maskEngagementText("https://www.example.net/700140000123/ こちらお願いします") === "https://www.example.net/700140000123/ こちらお願いします");
ok("普通の返信の中の携帯番号だけ伏せる", /〇〇/.test(maskEngagementText("ここに電話ください 090-1111-2222")) && isApplicationLikeText("ここに電話ください 090-1111-2222"));
ok("配線: line-webhook-text が記録の前に伏せる", /customer_reply_text: engagementTextMaskOn\(\) \? maskEngagementText\(/.test(readFileSync("app/lib/line-webhook-text.ts", "utf8")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
