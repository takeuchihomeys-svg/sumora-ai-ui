// app/lib/__tests__/business-clock.test.ts — 暦と営業時間の計算（純関数）
import { businessClock, businessClockLine, fixMdNichi } from "../business-clock";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const at = (iso: string) => Date.parse(iso);
const c1 = businessClock(at("2026-11-03T09:30:00Z")); // JST 11/3 18:30（祝日・火）
t("今日・明日・祝日", c1.today.md === "11/3" && c1.today.dow === "火" && c1.today.holiday === "文化の日" && c1.tomorrow.md === "11/4" && c1.tomorrow.holiday === null, c1);
t("18:30 は電話可・管理会社は明日・弊社はまだ", c1.phoneOk && c1.mgmtAfterHours && !c1.afterClose);
const c2 = businessClock(at("2026-11-03T12:10:00Z")); // JST 21:10
t("21:10 は電話終わり・弊社の終わり", !c2.phoneOk && c2.afterClose);
t("1行に M/D の決まり", /11\/3（火）・祝日（文化の日）/.test(businessClockLine(c1)) && /M\/D/.test(businessClockLine(c1)));
t("「11/2日」を直す", fixMdNichi("11/2日に内覧") === "11/2に内覧" && fixMdNichi("12日") === "12日");
console.log(`business-clock: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
