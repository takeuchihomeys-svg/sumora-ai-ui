import { applyIntentReplyFirstRule } from "../turn-contract";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
ok(applyIntentReplyFirstRule({ APPLY_INTENT_REPLY_FIRST: "off" }) === "", "off は1字も足さない");
const on = applyIntentReplyFirstRule({ APPLY_INTENT_FORM_STATE: "off" }); // 11/11 APPLY_INTENT_FORM_STATE 既定 on の後も、off の時の旧の文を確かめる
ok(on.includes("ご入居希望日は何日") && on.includes("AIX【申込】") && on.endsWith("\n") && !on.slice(0, -1).includes("\n"), "既定 on（11/10）で1行（読み方＋竹内さんの一手）");
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("apply-intent-reply-first: 全部 ok");
