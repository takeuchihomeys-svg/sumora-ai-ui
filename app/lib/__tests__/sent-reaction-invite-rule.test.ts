import { sentReactionInviteRule, BRAIN_TURN_CONTRACT_RULES } from "../turn-contract";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
ok(sentReactionInviteRule({}) !== "", "既定 on（11/06）");
ok(sentReactionInviteRule({ SENT_REACTION_VIEW_INVITE: "off" }) === "", "off は空");
const on = sentReactionInviteRule({ SENT_REACTION_VIEW_INVITE: "on" });
ok(on.includes("reaction_to_sent") && on.includes('route="reply"') && on.endsWith("\n") && !on.slice(0, -1).includes("\n"), "on で1行（返信で内覧に誘う）");
ok(BRAIN_TURN_CONTRACT_RULES.includes("気に入りました」とだけ返ってきた番") || (process.env.SENT_REACTION_VIEW_INVITE ?? "") === "off", "既定の規則に入る");
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("sent-reaction-invite-rule: 全部 ok");
