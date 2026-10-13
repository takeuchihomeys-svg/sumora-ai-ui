// app/lib/__tests__/meeting-place-form.test.ts — 待ち合わせ場所の2行目（実行: npx tsx app/lib/__tests__/meeting-place-form.test.ts）
//   実物: 竹内さんの実送信（scripts/audit-meeting-place-line.ts の行）
import { meetingDayOffset, meetingSecondLine, meetingDayWordOn } from "../meeting-place-form";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };
const at = (iso: string) => Date.parse(iso);

// 9/16 15:35 JST に 9/17 12:00 → 竹内さん「明日12:00〜ご案内させて頂きます！！」
t("明日＋時間", meetingSecondLine("9/17（木）", "12:00", at("2026-09-16T06:35:00Z")) === "明日12:00〜ご案内させて頂きます！！");
// 9/18 10:34 JST に 9/18 15:00 → 「本日15:00〜ご案内させて頂きます！！」
t("本日＋時間", meetingSecondLine("9/18（金）", "15:00", at("2026-09-18T01:34:00Z")) === "本日15:00〜ご案内させて頂きます！！");
// 9/22 21:04 JST に 9/26 → 雛形のまま（竹内さんは直さず送った）
t("先の日は雛形のまま", meetingSecondLine("9/26（土）", "18:00", at("2026-09-22T12:04:00Z")) === "9/26（土）ご案内させて頂きます！！");
// 日付をまたぐ: 23:30 JST（UTC 14:30）に翌日
t("日本時間で明日（UTC は同じ日）", meetingSecondLine("10/14（水）", "10:00", at("2026-10-13T14:30:00Z")) === "明日10:00〜ご案内させて頂きます！！");
t("時間なしは明日だけ", meetingSecondLine("10/14（水）", null, at("2026-10-13T03:00:00Z")) === "明日ご案内させて頂きます！！");
t("時間の後ろの幅は時間の頭だけ", meetingSecondLine("10/14（水）", "10:00〜11:00", at("2026-10-13T03:00:00Z")) === "明日10:00〜ご案内させて頂きます！！");
t("戻す（on=false）", meetingSecondLine("10/14（水）", "10:00", at("2026-10-13T03:00:00Z"), false) === "10/14（水）ご案内させて頂きます！！");
t("読めない日付は雛形のまま", meetingSecondLine("来週", "10:00", at("2026-10-13T03:00:00Z")) === "来週ご案内させて頂きます！！");
// 年をまたぐ
t("年またぎ 12/31→1/1 は明日", meetingDayOffset("1/1", at("2026-12-31T03:00:00Z")) === 1);
t("全角の日付", meetingDayOffset("１０／１４", at("2026-10-13T03:00:00Z")) === 1);
t("昨日は -1（雛形のまま）", meetingSecondLine("10/12（月）", "10:00", at("2026-10-13T03:00:00Z")) === "10/12（月）ご案内させて頂きます！！");
t("スイッチ", meetingDayWordOn({}, "MEETING_DAY_WORD") && !meetingDayWordOn({ MEETING_DAY_WORD: "off" }, "MEETING_DAY_WORD") && !meetingDayWordOn({ NEXT_PUBLIC_MEETING_DAY_WORD: "off" }, "NEXT_PUBLIC_MEETING_DAY_WORD"));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
