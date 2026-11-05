// app/lib/__tests__/flash-keep-dates.test.ts — 最終チェックの FLASH に渡す文の日付を丸めない（2026-11-05 竹内さん KB 95f492fc ③・FLASH_KEEP_DATES 既定 on）
import { maskForFlash, flashKeepDatesOn } from "../final-check-flash";
import { maskPII } from "../pii-mask";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const s = "山田さん11月15日（日）13:00に現地でお待ち合わせです。お電話は090-1234-5678まで";
const m = maskForFlash(s, ["山田"]);
t("日付は残す", m.includes("11月15日"), m);
t("名前は伏せる", !m.includes("山田"), m);
t("電話は伏せる", !m.includes("090-1234-5678"), m);
t("既定 on", flashKeepDatesOn({}) && !flashKeepDatesOn({ FLASH_KEEP_DATES: "off" }));
process.env.FLASH_KEEP_DATES = "off";
const old = maskForFlash(s, ["山田"]);
delete process.env.FLASH_KEEP_DATES;
t("off で旧（月に丸める）", !old.includes("11月15日") && old.includes("11月中"), old);
t("maskPII の既定は今まで通り丸める（他の経路は変えない）", maskPII("9月15日入居希望").includes("9月中"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
