import { sentCostEstimateRule } from "../turn-contract";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
ok(sentCostEstimateRule({}) !== "", "既定 on（11/06）");
ok(sentCostEstimateRule({ SENT_COST_ESTIMATE_AIX: "off" }) === "", "off は1字も足さない");
const on = sentCostEstimateRule({ SENT_COST_ESTIMATE_AIX: "on" });
ok(on.includes("estimate_sheet") && on.includes("初期費用176,180円") && on.endsWith("\n") && !on.slice(0, -1).includes("\n"), "on で1行（読み方＋竹内さんの一手）");
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("sent-cost-estimate-rule: 全部 ok");
