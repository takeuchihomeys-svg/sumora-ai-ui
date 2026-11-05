// app/lib/__tests__/company-facts-1105.test.ts — 竹内さん本人の ○×（KB P1 75120859）から足した会社の事実（COMPANY_FACT_1105・既定 on）
//   お客様の発言は 45日の本番の発言で当たりを読んだ物（名前・番号は無い文だけ）。配線: buildCompanyFactsNote（ブレインと書き手が読む1ブロック）
import { matchCompanyFacts, buildCompanyFactsNote, COMPANY_FACTS } from "../company-facts";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const IDS = ["proxy_contract_mail", "moving_company", "contract_juminhyo", "closed_days", "referral_fee", "room_share", "area_safety"];
const ids = (s: string) => matchCompanyFacts(s).map((f) => f.id).filter((i) => IDS.includes(i));
const off = <T,>(f: () => T): T => { process.env.COMPANY_FACT_1105 = "off"; try { return f(); } finally { delete process.env.COMPANY_FACT_1105; } };

// 当てる（本番の発言）
t("代理契約で親が来阪", ids("代理契約って親が大阪まで来なきゃ行けないとかありますか？").includes("proxy_contract_mail"));
t("代理契約の書類", ids("代理契約の時にお父さんが用意しておく書類聞きたいです🙏🏻").includes("proxy_contract_mail"));
t("引越し業者の手配", ids("今回引っ越し二度目なのですが引越し業者使ったことなくて、友人に聞いたら不動産で手配してもらったと聞いたのですが、こちらでは手配とかしてもらえたりできますか").includes("moving_company"));
t("住民票の問い", ids("あと、住民票は本籍地記載のものですか？").includes("contract_juminhyo"));
t("日曜は休みと思っている", ids("日曜なお休みと聞いておりますので、2日の午前中は何時から空いておりますか？").includes("closed_days"));
t("定休日", ids("定休日っていつですか？").includes("closed_days"));
t("紹介料", ids("友達紹介したら紹介料とかもらえますか？").includes("referral_fee"));
t("ルームシェア", ids("友達とルームシェアできる物件ありますか？").includes("room_share"));
t("治安", ids("大阪市で多少治安悪いとこだとどこになりますか？").includes("area_safety"));

// 当てない（監査で外した形）
t("記入済みの申込フォームの住民票", ids("【お申込者様記入欄】 ・入居希望日 11/16 ・現住所 〒（住民票記載）").length === 0, ids("【お申込者様記入欄】 ・現住所 〒（住民票記載）"));
t("土日の振込（銀行）", !ids("土日が現金振込み出来ないみたいで😭 どうしたらいいですかね").includes("closed_days"));
t("オートロックの防犯は治安の事実に当てない", !ids("夜道が不安なのでオートロック付きがいいです").includes("area_safety"));
t("紹介料を聞いていない紹介", !ids("友達に紹介されて連絡しました").includes("referral_fee"));
t("代理契約の可否だけの問いは手続きの事実に当てない", !ids("代理契約できますか？").includes("proxy_contract_mail"));
t("画像の書き起こしは当てない", ids("[画像] 引越し業者 手配 サービス").length === 0);

// 既定 on・off で止まる
t("off は渡さない", off(() => ids("定休日っていつですか？")).length === 0);

// 中身（竹内さんの決まり）
const fact = (id: string) => COMPANY_FACTS.find((f) => f.id === id)!.fact;
t("治安は西成区・浪速区だけ・生野区は挙げない", fact("area_safety").includes("西成区・浪速区だけ") && fact("area_safety").includes("生野区は挙げない") || fact("area_safety").includes("中央区・生野区は挙げない"));
t("紹介料は聞かれた時だけ・最低1万円", fact("referral_fee").includes("聞かれた時だけ") && fact("referral_fee").includes("最低1万円"));
t("ルームシェアは状況による", fact("room_share").includes("状況による"));
t("スモ割: 物件を送った直後の費用の質問に添えない・報酬が出ない物件はできない", fact("max_discount_sumora").includes("添えない") && fact("max_discount_sumora").includes("スモ割ができない"));
t("退去後の目安 2〜3週間", fact("vacating_move_in").includes("2〜3週間"));
t("専任・サクラは載らない事がある", fact("suumo_listing").includes("専任") && fact("suumo_listing").includes("サクラ"));
t("× ポストの開け方は入れない", !COMPANY_FACTS.some((f) => /totono|ポストの開け/.test(f.fact)));

// 配線: ブレインと書き手が読む1ブロックに出る
const note = buildCompanyFactsNote(["代理契約って親が大阪まで来なきゃ行けないとかありますか？"]);
t("配線: buildCompanyFactsNote", note.includes("郵送") && note.includes("会社として答えが決まっている事実"), note.slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
