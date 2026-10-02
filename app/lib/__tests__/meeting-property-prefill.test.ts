// app/lib/__tests__/meeting-property-prefill.test.ts — 2026-10-02 竹内「内覧日決まったら 1件目の内覧場所を集合場所とする」
//   実行: npx tsx app/lib/__tests__/meeting-property-prefill.test.ts
import { meetingPropertyPrefill } from "../aix-prefill";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

const one = "かしこまりました！！\n10/6(火) 13:00〜17:00\n安立荘(アンリュウソウ) 203号室、お部屋ご案内させて頂きます😊！！";
t("1件 → その物件", meetingPropertyPrefill([one])?.value === "安立荘(アンリュウソウ) 203号室", JSON.stringify(meetingPropertyPrefill([one])));
const timed = "10/8 ご案内させて頂きます！！\n14:00〜スプランディッド本町グラン 304号室\n13:00〜アーバネックス堺筋本町 502号室";
t("時刻つきで並べた → 一番早い時刻", meetingPropertyPrefill([timed])?.value === "アーバネックス堺筋本町 502号室", JSON.stringify(meetingPropertyPrefill([timed])));
const firstSaid = "9/9 15:00〜ミラージュパレス本町 801号室とリーダースパーク21 305号室、リーダースパーク21から先にご案内させて頂きます！！";
t("先にご案内と書いた物件", meetingPropertyPrefill([firstSaid])?.value === "リーダースパーク21 305号室", JSON.stringify(meetingPropertyPrefill([firstSaid])));
const listed = "MY江之子島マンション 403号室・エステムコート 701号室、2部屋ご案内させて頂きます😊！！\n9/28(月) 11:00〜14:00";
t("並べた順の1件目", meetingPropertyPrefill([listed])?.value === "MY江之子島マンション 403号室", JSON.stringify(meetingPropertyPrefill([listed])));
t("物件のオススメの文（🌟）は内覧のご案内として拾わない", meetingPropertyPrefill(["🌟ルミエール新大阪 301号室 お送りさせて頂きましたお部屋の中でも特にオススメ！！ご案内させて頂きます 10/1"]) === null);
t("内覧の文が無い → null", meetingPropertyPrefill(["お世話になっております！！"]) === null);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
