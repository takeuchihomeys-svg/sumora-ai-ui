import { sentReactionInviteRule, BRAIN_TURN_CONTRACT_RULES } from "../turn-contract";


let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
ok(sentReactionInviteRule({}) !== "", "既定 on（11/06）");
ok(sentReactionInviteRule({ SENT_REACTION_VIEW_INVITE: "off" }) === "", "off は空");
const on = sentReactionInviteRule({ SENT_REACTION_VIEW_INVITE: "on" });
ok(on.includes("reaction_to_sent") && on.includes('route="reply"') && on.endsWith("\n") && !on.slice(0, -1).includes("\n"), "on で1行（返信で内覧に誘う）");
ok(BRAIN_TURN_CONTRACT_RULES.includes("気に入りました」とだけ返ってきた番") || (process.env.SENT_REACTION_VIEW_INVITE ?? "") === "off", "既定の規則に入る");
// 2026-11-06 誘いを1か所で（VIEW_INVITE_ONE_PLACE）
const one = sentReactionInviteRule({ VIEW_INVITE_ONE_PLACE: "on" });
ok(one.includes("viewing_invite") && one.includes("退去予定") && one.endsWith("\n") && !one.slice(0, -1).includes("\n"),"on: 空室は AIX【内覧調整】・退去予定は返信の1行");
ok(!sentReactionInviteRule({}).includes("viewing_invite"), "既定 off は今の返信の誘いのまま");
if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("sent-reaction-invite-rule: 全部 ok");
