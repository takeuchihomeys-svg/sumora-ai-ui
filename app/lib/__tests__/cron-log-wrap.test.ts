// app/lib/__tests__/cron-log-wrap.test.ts — 高頻度の cron の記録は毎時0分の回だけ（DB は使わない・cron-logger の読み込みに URL が要るので --env-file=.env.local を付けて回す）
import { hourlySample, cronLogWrapOn } from "../cron-log-wrap";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log(`  NG ${n}`); } };
t("毎時0分は書く", hourlySample(Date.parse("2026-11-21T13:00:20Z")));
t("1分は書かない", !hourlySample(Date.parse("2026-11-21T13:01:00Z")));
t("59分は書かない", !hourlySample(Date.parse("2026-11-21T13:59:59Z")));
t("既定 on", cronLogWrapOn({}));
t("off で止まる", !cronLogWrapOn({ CRON_LOG_WRAP: "off" }));
console.log(`cron-log-wrap: ${pass} 通過・${fail} 失敗`);
if (fail) process.exit(1);
