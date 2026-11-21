// AIX【物件オススメ】で送った物件を送った物件の記録に足す（2026-11-21 作業員G）。7日の4件の形を伏せて写した
// 実行: npx tsx app/lib/__tests__/recommendation-sent-record.test.ts
import { recommendationSentRecordOn, recommendationSentRow, splitNameRoom } from "../recommendation-sent-record";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

// 写真1枚＋「（室内イメージ）URL」＋「🌟名前 号室…」の4件（記録の物件名は1件）
const A = recommendationSentRow({ aixType: "property_recommendation", propertyNames: ["〇〇.maison（〇.メゾン） 302号室"], lineMessageId: "641014556902031758" });
ok("名前と号室に分ける（括弧つきの名前）", A?.propertyName === "〇〇.maison（〇.メゾン）" && A.roomNo === "302");
ok("ローマ数字の付く名前", recommendationSentRow({ aixType: "property_recommendation", propertyNames: ["〇〇レジデンス今里II 301号室"] })?.propertyName === "〇〇レジデンス今里II");
ok("号室が無ければ空", recommendationSentRow({ aixType: "property_recommendation", propertyNames: ["〇〇阿波座Bloom"] })?.roomNo === "");
ok("試験の行（bexam-）は足さない", recommendationSentRow({ aixType: "property_recommendation", propertyNames: ["〇〇 901号室"], lineMessageId: "bexam-l-xxxx" }) === null);
ok("物件が2件以上は足さない", recommendationSentRow({ aixType: "property_recommendation", propertyNames: ["A 101号室", "B 202号室"] }) === null);
ok("物件名が無ければ足さない", recommendationSentRow({ aixType: "property_recommendation", propertyNames: [] }) === null);
ok("オススメ以外の AIX は足さない", recommendationSentRow({ aixType: "property_send", propertyNames: ["A 101号室"] }) === null);
ok("全角の空白", splitNameRoom("〇〇大今里　203号室").roomNo === "203");
ok("既定 off", recommendationSentRecordOn({}) === false && recommendationSentRecordOn({ RECOMMENDATION_SENT_RECORD: "on" }) === true);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
