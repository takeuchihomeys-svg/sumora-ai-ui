// 実行: npx tsx app/lib/__tests__/company-facts-1008.test.ts
// 2026-10-08 竹内さんの答え: 申込の時期（基本的に30日前）・オーナー審査以降のキャンセル料・SUUMO の物件・虫（7階以上）・業者の名前は聞かれた時だけ・緊急連絡先は電話のみ
//   お客様の文・スタッフの文は実物（scripts/audit-r12-company-facts-1008.ts で読んだ通）
import { matchCompanyFacts, buildCompanyFactsNote, isVendorNameQuestion } from "../company-facts";
import { findCompanyFactContradiction, findUnaskedVendorName, findCompanyFactContradictionsUngated } from "../company-fact-guard";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }
const ids = (s: string | string[]) => matchCompanyFacts(s).map((f) => f.id);
const has = (s: string | string[], id: string) => ids(s).includes(id);

console.log("■ 申込の時期（apply_window）");
t("9/06「10月29日くらいから入居希望ですが／それでも申し込みは出来ますか？」", has("ありがとうございます！\n10月29日くらいから入居希望ですが\nそれでも申し込みは出来ますか？", "apply_window"));
t("8/25「10月末入居希望だといつ頃申し込めばいいでしょうか？」", has("10月末入居希望だといつ頃申し込めばいいでしょうか？", "apply_window"));
t("申込の依頼そのもの「10/1入居でお申し込みお願いできますか」は当てない", !has("10/1入居でお申し込みお願いできますか🙏🏻", "apply_window"));
t("「今申し込んだら最短いつから住めるのでしょうか？」（最短＝screening_flow）は当てない", !has("今申し込んだら最短いつから住めるのでしょうか？", "apply_window"));
t("事実は「基本的に」30日前・例外あり", /基本的にご入居日の30日前から/.test(buildCompanyFactsNote("10月末入居希望だといつ頃申し込めばいいでしょうか？")) && /例外/.test(buildCompanyFactsNote("10月末入居希望だといつ頃申し込めばいいでしょうか？")));

console.log("■ キャンセル（オーナー審査以降は家賃1ヶ月分）");
const cancelNote = buildCompanyFactsNote("キャンセル料ってかかりますか？");
t("オーナー審査以降は家賃1ヶ月分", /オーナー審査以降にキャンセルする場合は、キャンセル料として家賃1ヶ月分/.test(cancelNote), cancelNote.slice(0, 200));
t("保証会社の審査通過後オーナー審査に移るまではかからない", /オーナー審査に移るまではキャンセル料がかからない/.test(cancelNote));
t("仮押さえの事実にも同じ向き", /オーナー審査以降のキャンセルはキャンセル料として家賃1ヶ月分/.test(buildCompanyFactsNote("仮押さえってできますか？")));

console.log("■ SUUMO（suumo_listing）");
t("9/11「ネットで見つけた気になる部屋を送っても大丈夫でしょうか？」", has("ネットで見つけた気になる部屋を送っても大丈夫でしょうか？", "suumo_listing"));
t("7/31「スーモに乗ってやつしか案内できないですか？」", has("スーモに乗ってやつしか案内できないですか？自分で調べてみて見てみたいところがあるのですが", "suumo_listing"));
t("9/16「募集終了て言われた物件がSUUMOで即入居でありますが見落としとかではないですか？」", has("募集終了て言われた物件がSUUMOで即入居でありますが見落としとかではないですか？\nプルス新北野 3階\nhttps://suumo.jp/chintai/bc_100526248899/\nby SUUMO", "suumo_listing"));
t("URL と by SUUMO だけの共有は当てない", !has("ウェスト宮ノ下 5階\nhttps://suumo.jp/chintai/bc_100525262108/\nby SUUMO", "suumo_listing"));
t("オトリの話（portal-notice）は当てない", !has("SUUMOかホームズで見るのがいちばんおとり物件がすくないですか？", "suumo_listing"));
t("事実: 取り扱える・2週間の更新・確認の約束", ((n) => /募集していれば基本的にすべて取り扱える/.test(n) && /2週間/.test(n) && /募集状況を確認する約束/.test(n))(buildCompanyFactsNote("スーモとかで気になる物件あればこちらに送ってもいいですか？")));

console.log("■ 虫（bugs_high_floor）");
t("9/05「2階だと虫とかって入ってきますかね？😭」", has("遅くなり申し訳ないです💦\n2階だと虫とかって入ってきますかね？😭", "bugs_high_floor"));
t("7/22「虫大の苦手なので、さいていでも5階からがいいです」", has("あと、虫大の苦手なので、さいていでも5階からがいいです😿", "bugs_high_floor"));
t("駅名（松虫）は当てない", !has("松虫駅の近くはありますか？", "bugs_high_floor"));
t("入居後の苦情（湧いて困っている）は当てない", !has("虫が湧いてきたりと困っています...管理会社様にお伝えしていただく事は可能でしょうか？", "bugs_high_floor"));
t("条件のフォームは当てない", !has("①【ご入居の時期】⇒最短\n②【ご希望の家賃】⇒10万\n⑧【その他】⇒虫が苦手なので高層階", "bugs_high_floor"));
t("事実: 7階以上", /7階以上/.test(buildCompanyFactsNote("2階だと虫とかって入ってきますかね？")));

console.log("■ 業者の名前（vendor_name）");
for (const q of ["管理会社どこでしたっけ？？", "ちなみにこの物件の管理会社ってどちらですか？？", "後管理会社の電話番号を教えて欲しいです。", "不動産屋の会社名教えてください"]) t(`聞いた: ${q}`, isVendorNameQuestion(q) && has(q, "vendor_name"));
t("「違う業者断ったらしく物件名教えてくれないみたいで」は聞いていない", !isVendorNameQuestion("もう違う業者断ったらしく物件名教えてくれないみたいで。"));
t("引越し業者は外す", !has("引越し業者どこがいいですか？", "vendor_name"));
const NAMED = "こちら管理会社は株式会社エマスタイルという管理会社となります！！";
t("聞かれていない時の社名は出口で当たる", findUnaskedVendorName(NAMED, ["ありがとうございます！"])?.factId === "vendor_name");
t("findCompanyFactContradiction でも当たる（final-check V16 の入口）", findCompanyFactContradiction(NAMED, ["よろしくお願いします"])?.factId === "vendor_name");
t("聞かれた時は当てない（9/30 の実送信）", findCompanyFactContradiction(NAMED, ["それと審査の件ですがこの物件の管理会社はどこですか？？"]) === null);
t("役割だけ（管理会社に確認させて頂きます）は当てない", findUnaskedVendorName("管理会社に確認させて頂きます！！", ["ペット可ですか？"]) === null);
t("自社名（蓮産業株式会社）は当てない", findUnaskedVendorName("蓮産業株式会社という会社となります！！", ["はい"]) === null);
t("勤務先の会社（株式会社〇〇に転職という形で管理会社に共有）は当てない", findUnaskedVendorName("個人事業主:adcateから株式会社Rindouに転職という形で管理会社に共有させていただきます！！", ["よろしくお願いします！"]) === null);
process.env.COMPANY_FACT_VENDOR_NAME = "off";
t("COMPANY_FACT_VENDOR_NAME=off で止まる", findUnaskedVendorName(NAMED, ["はい"]) === null);
delete process.env.COMPANY_FACT_VENDOR_NAME;

console.log("■ 緊急連絡先（電話のみ・支払い義務なし）");
t("「緊急連絡先の方にもお支払いの義務がございます」は当たる", findCompanyFactContradictionsUngated("緊急連絡先の方にもお支払いの義務がございます！！").some((h) => h.factId === "emergency_contact"));
t("「緊急連絡先の方にお支払いの義務はございません」は当てない", !findCompanyFactContradictionsUngated("緊急連絡先の方には確認のお電話が入るだけで、お支払いの義務はございません！！").some((h) => h.factId === "emergency_contact"));
t("連帯保証人と対比の文は当てない", !findCompanyFactContradictionsUngated("緊急連絡先と違い連帯保証人は支払い義務がございます！！").some((h) => h.factId === "emergency_contact"));
t("聞かれた時に出口で当たる", findCompanyFactContradiction("緊急連絡先の方にも家賃の支払い責任が発生致します", ["緊急連絡先に電話かかることはありますか？🥲"])?.factId === "emergency_contact");
t("事実に申込フォームの欄の説明", /申込フォームの「緊急連絡先」欄/.test(buildCompanyFactsNote("緊急連絡先って、親のやつ書いたらなにか連絡いったりしますか、？")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
