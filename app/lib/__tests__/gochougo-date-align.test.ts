// GOCHOUGO_AFTER_DATE の修正案が自分の検査に当たる形と、竹内さんの候補の時間つきの形（2026-11-13 作業員9・弱い所 685・FC_GOCHOUGO_DATE_ALIGN）
// 実行: npx tsx app/lib/__tests__/gochougo-date-align.test.ts
import { runVocabSemanticChecks, type FinalCheckContext } from "../final-check";
import { hasConcreteSlot, gochougoDateAlignOn } from "../final-check-facts-source";
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
t("既定 off", !gochougoDateAlignOn({}));
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
delete process.env.FC_GOCHOUGO_DATE_ALIGN;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
