import { viewingTimeOnlyRule } from "../turn-contract";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
ok(viewingTimeOnlyRule({}) !== "", "既定 on（11/06）");
ok(viewingTimeOnlyRule({ VIEWING_TIME_ONLY_NO_MEETING: "off" }) === "", "off は1字も足さない");
const on = viewingTimeOnlyRule({ VIEWING_TIME_ONLY_NO_MEETING: "on" });
ok(on.includes("待ち合わせ場所") && on.includes('route="reply"') && on.endsWith("\n") && !on.slice(0, -1).includes("\n"), "on で1行（行き先が未定なら返信で受ける）");
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("viewing-time-only-rule: 全部 ok");
