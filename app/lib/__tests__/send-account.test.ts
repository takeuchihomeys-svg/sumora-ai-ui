// 2026-10-20 竹内さん（P1 f9d261d4）「ギガ賃貸のアカウントの AIX ツールから送る場合はギガ賃貸に飛ぶようにする」— アカウントの取り違えを止める
// 実行: npx tsx app/lib/__tests__/send-account.test.ts
import { readFileSync } from "fs";
import { join } from "path";
import { toAccountKey, accountLabelOf, checkSendAccount, pickConversationForCustomer, multiAccountConfirmMessage, sendAccountGateEnabled, pickConvByCustomerMsgEnabled } from "../send-account";
import { pickupTargetConversation, buildPickupAixHref, parsePickupAixHandoff, handoffAccountMismatch } from "../pickup-aix-handoff";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const root = join(__dirname, "..", "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

console.log("■ アカウントの名前");
t("英語のキーはそのまま", toAccountKey("giga") === "giga" && toAccountKey("ieyasu") === "ieyasu");
t("日本語の名前 → キー", toAccountKey("ギガ賃貸") === "giga" && toAccountKey("イエヤス") === "ieyasu" && toAccountKey("スモラ") === "sumora");
t("分からない → null", toAccountKey("") === null && toAccountKey("xxx") === null && toAccountKey(null) === null);
t("画面の名前", accountLabelOf("giga") === "ギガ賃貸" && accountLabelOf(null) === "不明");

console.log("■ 送る直前の確かめ（会話のアカウント＝送るアカウント）");
const ng = checkSendAccount("ieyasu", "giga");
t("ギガ賃貸の会話にイエヤスから送ろうとした → 止める", !ng.ok && ng.reason === "account_mismatch" && /ギガ賃貸/.test(ng.message) && /イエヤス/.test(ng.message), ng);
const ok = checkSendAccount("giga", "giga");
t("同じアカウント → 会話のアカウントで送る", ok.ok && ok.key === "giga" && ok.source === "conversation");
t("日本語の名前でも同じなら通す", checkSendAccount("ギガ賃貸", "giga").ok);
const noReq = checkSendAccount(undefined, "ieyasu");
t("画面がアカウントを渡さない → 会話のアカウント（LINE の id で引かない）", noReq.ok && noReq.key === "ieyasu" && noReq.source === "conversation");
const noConv = checkSendAccount("sumora", null);
t("会話のアカウントが分からない（古い呼び出し）→ 今まで通り画面の値", noConv.ok && noConv.key === "sumora" && noConv.source === "requested");
t("どちらも無い → 呼び出し側の旧の引き方", (() => { const r = checkSendAccount(null, null); return r.ok && r.key === null && r.source === "none"; })());
t("戻すスイッチ（SEND_ACCOUNT_GATE=off）", sendAccountGateEnabled({}) && !sendAccountGateEnabled({ SEND_ACCOUNT_GATE: "off" }));

console.log("■ お客様 → 会話（同じ人が2つのアカウントにいる）");
const two = [
  { id: "conv-ieyasu", account: "ieyasu", updated_at: "2026-10-16T08:13:51Z", last_customer_at: "2026-09-30T10:11:32Z" },
  { id: "conv-sumora", account: "sumora", updated_at: "2026-10-10T00:00:00Z", last_customer_at: "2026-10-11T13:36:23Z" },
];
const p = pickConversationForCustomer(two);
t("updated_at が新しくても、お客様が最後に話した会話を選ぶ（10/12 の取り違えの形）", p.id === "conv-sumora", p);
t("2つのアカウント → ambiguous", p.ambiguous && p.accounts.length === 2);
t("お客様が話していない時は updated_at", pickConversationForCustomer([{ id: "a", account: "sumora", updated_at: "2026-10-01T00:00:00Z" }, { id: "b", account: "sumora", updated_at: "2026-10-02T00:00:00Z" }]).id === "b");
t("1つだけ → それ・ambiguous でない", (() => { const r = pickConversationForCustomer([{ id: "x", account: "giga" }]); return r.id === "x" && !r.ambiguous; })());
t("0件 → null", pickConversationForCustomer([]).id === null);
t("戻すスイッチ（PICKUP_CONV_BY_CUSTOMER_MSG=off）", pickConvByCustomerMsgEnabled({}) && !pickConvByCustomerMsgEnabled({ PICKUP_CONV_BY_CUSTOMER_MSG: "off" }));

console.log("■ AIX ツールの送る前の確かめ");
const m = multiAccountConfirmMessage("giga", ["giga", "ieyasu", "giga"]);
t("2つのアカウント → 送り先のアカウントを書いて確かめる", !!m && /【ギガ賃貸】/.test(m) && /イエヤス/.test(m), m);
t("1つのアカウント → 確かめない", multiAccountConfirmMessage("giga", ["giga"]) === null && multiAccountConfirmMessage("giga", []) === null);

console.log("■ 送る回の会話（回の会話を先に）");
t("回の会話を一覧の会話より先に使う", pickupTargetConversation({ batchConversationIds: ["conv-giga"], customerConversationId: "conv-ieyasu" }).conv === "conv-giga");
t("回に会話が無い時だけ一覧の会話", pickupTargetConversation({ batchConversationIds: [null], customerConversationId: "conv-ieyasu" }).conv === "conv-ieyasu");
t("回の中で会話が2つ → 送らない", (() => { const r = pickupTargetConversation({ batchConversationIds: ["a", "b"], customerConversationId: "a" }); return r.mixed && r.conv === null; })());

console.log("■ 受け渡しの URL にアカウントを載せ、トーク側で照らす");
const href = buildPickupAixHref({ conversationId: "c1", pickupIds: [5], batchId: "b", account: "giga" });
t("URL に acct が載る", href === "/?conv=c1&aix=property_recommendation&pickup=5&batch=b&acct=giga", href);
t("acct が無ければ今までの URL", buildPickupAixHref({ conversationId: "c1", pickupIds: [5], batchId: "b" }) === "/?conv=c1&aix=property_recommendation&pickup=5&batch=b");
const parsed = parsePickupAixHandoff(new URL(`http://x${href}`).search);
t("トーク側で acct を読める", parsed?.acct === "giga", parsed);
t("旧の URL は acct なし", parsePickupAixHandoff("?conv=c&aix=property_send&pickup=7,8")?.acct === undefined);
t("開いた会話のアカウントが違う → 止める文", /ギガ賃貸/.test(handoffAccountMismatch("giga", "ieyasu") ?? "") && /イエヤス/.test(handoffAccountMismatch("giga", "ieyasu") ?? ""));
t("同じ・分からない → 止めない", handoffAccountMismatch("giga", "giga") === null && handoffAccountMismatch(null, "giga") === null && handoffAccountMismatch("giga", null) === null);

console.log("■ 配線（送る口がすべて確かめを通る）");
const slm = src("app/api/send-line-message/route.ts");
t("send-line-message: 会話のアカウントを読み checkSendAccount で止める", /select\("line_user_id, send_blocked_reason, account"\)/.test(slm) && /checkSendAccount\(account, convAccount\)/.test(slm) && /account_mismatch|acctCheck\.reason/.test(slm));
t("send-line-message: 会話のアカウントがある時はそれで送る", /acctCheck\.source === "conversation" && acctCheck\.key \? acctCheck\.key : await resolveAccountKey/.test(slm));
const ssm = src("app/api/send-scheduled-messages/route.ts");
t("予約の送信: 行のアカウントと会話のアカウントを照らす", /checkSendAccount\(msg\.account/.test(ssm) && /select\("line_user_id, send_blocked_reason, (?:auto_send_enabled, )?account"\)/.test(ssm));
const pps = src("app/lib/property-pickups-server.ts");
t("売上サポの記録: お客様 → 会話を updated_at で引かない", /primaryConversationForCustomer\(supabase, propertyCustomerId\)/.test(pps) && !/eq\("property_customer_id", propertyCustomerId\)\.order\("updated_at", \{ ascending: false \}\)\.limit\(1\)/.test(pps));
t("子の行の親の会話も同じ選び方", /primaryConversationForCustomer\(sb, parent\)/.test(src("app/lib/customer-family.ts")));
const pr = src("app/components/PickupReview.tsx");
t("AIX ツール: 回の会話で送る・2つのアカウントなら確かめる・URL にアカウント", /pickupTargetConversation\(/.test(pr) && /multiAccountConfirmMessage\(convAccount/.test(pr) && /account: convAccount/.test(pr) && !/const convId = c\.conversation_id \?\? b\.conversation_id;/.test(pr));
const pg = src("app/page.tsx");
t("トーク: 受け渡しのアカウントと開いた会話のアカウントを照らす", /handoffAccountMismatch\(h\.acct, selectedConversation\?\.account\)/.test(pg));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
