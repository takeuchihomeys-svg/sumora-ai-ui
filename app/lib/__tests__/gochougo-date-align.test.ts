// GOCHOUGO_AFTER_DATE の修正案が自分の検査に当たる形と、竹内さんの候補の時間つきの形（2026-11-13 作業員9・弱い所 685・FC_GOCHOUGO_DATE_ALIGN）
// 実行: npx tsx app/lib/__tests__/gochougo-date-align.test.ts
import { runVocabSemanticChecks, type FinalCheckContext } from "../final-check";
import { hasConcreteSlot, gochougoDateAlignOn, gochougoCondTemplateOn, stripConditionTemplate } from "../final-check-facts-source";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const ctxOf = (cust: string) => ({ lastCustomerMessage: cust, recentMessages: [{ sender: "customer", text: cust }] } as unknown as FinalCheckContext);
const fires = (text: string, cust: string) => runVocabSemanticChecks(text, ctxOf(cust)).find((i) => i.code === "GOCHOUGO_AFTER_DATE");
// 実物（名前は伏せた）: お客様が日を言った番の竹内さんの送信
const cust1 = "本日は厳しいので18日はどうでしょうか？\nこちら内覧希望です";
const sent1 = "かしこまりました！！\n9/18お部屋ご案内させて頂きます！！\n\n9/18(金) 10:30〜11:30 17:00〜18:30\nご案内可能です😊！！\n〇〇さんご都合よろしいお時間御座いますでしょうか！！";
const cust2 = "来週月曜の、夕方は空いてますでしょうか？\n今週の土曜内覧可能ですか？";
const sent2 = "〇〇さんお世話になっております！！\nかしこまりました！！\n2部屋まとめてお部屋ご案内させて頂きます！！\n\n10/24(土) 14:00〜16:00 \nご案内可能です😊！！\n\n〇〇さんご都合よろしいお時間御座いますでしょうか😌！！";
// 旧の修正案のとおりに書いた文（「〇日でご都合よろしいお時間御座いますでしょうか」）
const oldFix = "かしこまりました！！\n18日でご都合よろしいお時間御座いますでしょうか！！";
// 本当に止めるべき形: 日を言われたのに、候補も無くまた日にちを聞く
const bad = "かしこまりました！！\nご都合よろしいお日にち御座いますでしょうか😌！！";

delete process.env.FC_GOCHOUGO_DATE_ALIGN;
t("既定 on（2026-11-13 監査の後）・off で戻る", gochougoDateAlignOn({}) && !gochougoDateAlignOn({ FC_GOCHOUGO_DATE_ALIGN: "off" }));
process.env.FC_GOCHOUGO_DATE_ALIGN = "off";
t("off: 竹内さんの送信（候補の時間つき）も止まる＝誤った止め", !!fires(sent1, cust1) && !!fires(sent2, cust2));
t("off: 旧の修正案のとおりに直した文が、また同じ検査に当たる", !!fires(oldFix, cust1));
process.env.FC_GOCHOUGO_DATE_ALIGN = "on";
t("on: 竹内さんの送信（候補の時間つき）は止めない", !fires(sent1, cust1) && !fires(sent2, cust2));
const b = fires(bad, cust1);
t("on: 候補が無く日にちを聞き直す文は止める", !!b);
t("on: 修正案は候補の時間を先に書く形（「〇日でご都合よろしいお時間」を勧めない）", !!b && !/〇日でご都合よろしいお時間/.test(b.suggestion ?? "") && /候補の時間/.test(b.suggestion ?? ""), b?.suggestion);
t("on: 旧の修正案の文（候補の時間なし）は止める（勧めない形）", !!fires(oldFix, cust1));
t("候補の日時: 月/日＋時刻", hasConcreteSlot("10/24(土) 14:00〜16:00") && hasConcreteSlot("9/18(金) 10:30〜11:30"));
t("候補の日時: 日だけ・時刻だけでは無い", !hasConcreteSlot("18日でご都合") && !hasConcreteSlot("15時頃に"));
// 2026-11-14 作業員B（FC_GOCHOUGO_COND_TEMPLATE 既定 off）: お客様の条件の書式を日にちの指定と読まない（実物・名前は伏せた）
const custTpl = "①【ご入居の時期】⇒9月以降\n②【ご希望の家賃（◯万円〜◯万円）】⇒17万以内\n③【希望の広さ・間取り】⇒2LDK\n⑤【ご希望のエリア・駅名】⇒阿波座 本町";
const sentTpl = "2DKのお部屋ですが新着で1件〇〇さんにかなりオススメ出来るお部屋となります！！\n〇〇さんお気に召されたお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
process.env.FC_GOCHOUGO_DATE_ALIGN = "on";
process.env.FC_GOCHOUGO_COND_TEMPLATE = "off";
t("条件の書式: 既定 on・off で戻る（off なら今までどおり止まる）", gochougoCondTemplateOn({}) && !gochougoCondTemplateOn({ FC_GOCHOUGO_COND_TEMPLATE: "off" }) && !!fires(sentTpl, custTpl));
process.env.FC_GOCHOUGO_COND_TEMPLATE = "on";
t("条件の書式: on で竹内さんの送信を止めない", !fires(sentTpl, custTpl));
t("条件の書式: on でも、書式の外で日を言った番は止める", !!fires(bad, "条件は前のとおりです\n①【ご入居の時期】⇒9月以降\n18日に内覧希望です"));
t("条件の書式: on でも、日を言った番の候補なしの聞き直しは止める（cust1）", !!fires(bad, cust1));
t("書式と注釈を外す", stripConditionTemplate("よろしくお願いします！\n①【ご入居の時期】⇒9月以降\n〔AIX-META〕顧客インテント: decision 10/29").trim() === "よろしくお願いします！");
delete process.env.FC_GOCHOUGO_COND_TEMPLATE;
delete process.env.FC_GOCHOUGO_DATE_ALIGN;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
