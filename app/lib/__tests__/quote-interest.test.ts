// app/lib/__tests__/quote-interest.test.ts — 引用の問いの関心（2026-11-26 作業員A・#793）
//   実行: npx tsx app/lib/__tests__/quote-interest.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteInterestOf, quoteInterestOn } from "../quote-interest";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
// 60日の引用の返信の型（実物の言い回し・物件名なし）
t("費用", quoteInterestOf("これは初期費用何円ですか").join() === "cost" && quoteInterestOf("あとこれも初期費用教えて欲しいです").join() === "cost" && quoteInterestOf("12月末入居でしたら日割りかかりますか？").join() === "cost");
t("内覧", quoteInterestOf("ここも見れますか？").join() === "viewing");
t("審査: 申込より前だけ", quoteInterestOf("ここ審査通りやすいですか？").join() === "screening" && quoteInterestOf("ここ審査通りやすいですか？", { postApply: true }).length === 0);
t("空き", quoteInterestOf("まだ空いてますか？").join() === "vacancy");
t("問いでない・お礼だけ・断りは返さない", quoteInterestOf("かしこまりました！ご連絡ありがとうございます").length === 0 && quoteInterestOf("家賃が微妙なので見送ります？").length === 0);
t("気に入った: 問いでなくても・断念や保留は返さない", quoteInterestOf("こちらの物件気になります").join() === "liked" && quoteInterestOf("ここが気になりますね！初期費用どのくらいになりますか？").join() === "cost,liked" && quoteInterestOf("とても気になっていたんですが断念いたしました").length === 0 && quoteInterestOf("少し築年数が気になります。また、独立洗面所がないのも懸念点です").length === 0 && quoteInterestOf("ここはあいてますか？？").join() === "vacancy");
t("既定 on", quoteInterestOn({}) && !quoteInterestOn({ SENT_QUOTE_INTEREST: "off" }));
const wh = readFileSync(join(__dirname, "..", "line-webhook-text.ts"), "utf8"), ms = readFileSync(join(__dirname, "..", "..", "api", "migrate-schema", "route.ts"), "utf8");
t("配線: 別の update・申込以降は審査を外す・migrate-schema に列", wh.includes("customer_interest_points: interest") && wh.includes("postApply: isPostApplyStatus(") && ms.includes("ADD COLUMN IF NOT EXISTS customer_interest_points TEXT[]"));
console.log(`quote-interest: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
