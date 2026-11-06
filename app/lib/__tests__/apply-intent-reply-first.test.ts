import { applyIntentReplyFirstRule } from "../turn-contract";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
ok(applyIntentReplyFirstRule({}) === "", "既定 off は1字も足さない");
const on = applyIntentReplyFirstRule({ APPLY_INTENT_REPLY_FIRST: "on" });
ok(on.includes("ご入居希望日は何日") && on.includes("AIX【申込】") && on.endsWith("\n") && !on.slice(0, -1).includes("\n"), "on で1行（読み方＋竹内さんの一手）");
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("apply-intent-reply-first: 全部 ok");
