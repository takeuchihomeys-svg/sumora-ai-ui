// app/lib/__tests__/schedule-line-dedupe.test.ts — 2026-10-02 ⑫（実行: npx tsx app/lib/__tests__/schedule-line-dedupe.test.ts）
import { dedupeScheduleLines } from "../schedule-line-dedupe";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const dup = "かしこまりました！！\n気になる3部屋ご案内させて頂きます！！\n直近ですと10/15(木) 14:00〜16:00にてご案内可能です😊！！\n10/15(木) 14:00〜16:00にてご案内可能です！！\nYUMAさんご都合よろしいお日にち御座いますでしょうか😌！！";
const r = dedupeScheduleLines(dup);
t("実物（DeepSeek の AIX【内覧調整】）の2回目の日時の行を落とす", r.removed.length === 1 && r.text.split("\n").length === 4, r.text);
const human = "かしこまりました！！\n8/6 14:00ご案内させて頂きます！！\n\n8/6 14:00にスプランディッド難波VII\n現地エントランス前お待ち合わせ";
t("日時が同じでも違う文（人の実物 4aef01ff）は残す", dedupeScheduleLines(human).removed.length === 0);
t("日時の違う行は残す", dedupeScheduleLines("10/3(土) 11:00〜13:00\n10/4(日) 14:00〜16:00").removed.length === 0);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
