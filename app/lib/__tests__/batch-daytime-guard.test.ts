// app/lib/__tests__/batch-daytime-guard.test.ts — 夜の一括の cron の昼の守り（純関数）
import { daytimeDecision } from "../batch-daytime-guard";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("夜はそのまま", daytimeDecision({ hour: 23, force: false, mode: "adaptive", failures: 5 }).scale === 1);
t("昼・調子が良い＝半分・間2倍", (() => { const d = daytimeDecision({ hour: 13, force: false, mode: "adaptive", failures: 0 }); return d.run && d.scale === 0.5 && d.pauseScale === 2; })());
t("昼・調子が悪い＝動かない", !daytimeDecision({ hour: 13, force: false, mode: "adaptive", failures: 2 }).run);
t("昼・読めない＝動かない", !daytimeDecision({ hour: 13, force: false, mode: "adaptive", failures: null }).run);
t("strict は今まで通り", !daytimeDecision({ hour: 13, force: false, mode: "strict", failures: 0 }).run && daytimeDecision({ hour: 13, force: true, mode: "strict", failures: 0 }).run);
console.log(`batch-daytime-guard: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
