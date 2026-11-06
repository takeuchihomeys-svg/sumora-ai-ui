import { sentReactionNoEstimateOn } from "../turn-contract";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
ok(!sentReactionNoEstimateOn({}), "既定 off");
ok(sentReactionNoEstimateOn({ SENT_REACTION_NO_ESTIMATE: "on" }), "on");
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("sent-reaction-no-estimate: 全部 ok");
