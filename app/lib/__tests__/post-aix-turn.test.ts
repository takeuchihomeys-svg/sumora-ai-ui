// AIX の続き（2通目）の番を会話の記録から決める（2026-10-15 竹内悠馬・KAORI さん）
// 実行: npx tsx app/lib/__tests__/post-aix-turn.test.ts
import { resolvePostAixTurn, postAixTurnState, postAixDirectTemplateOn, postAixTurnFromLogEnabled, buildAixTemplateRequestBody } from "../post-aix-turn";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

// KAORI さんの 10/12 の並び（日本時間 20:40 お客様 → 20:57 AIX の画像・室内イメージ・🌟カード）
const base = [
  { sender: "customer", text: "よろしくお願いします", rawCreatedAt: "2026-10-12T11:40:01.583Z" },
  { sender: "staff", text: "[画像]", isAix: true, rawCreatedAt: "2026-10-12T11:57:33.322Z" },
  { sender: "staff", text: "（室内イメージ）\nhttps://suumo.jp/chintai/x/", isAix: true, rawCreatedAt: "2026-10-12T11:57:33.595Z" },
  { sender: "staff", text: "🌟グランノーブルⅡ 203\n\n（オススメポイント）\n・家賃68,000円・管理費7,700円（合計75,700円）", isAix: true, rawCreatedAt: "2026-10-12T11:57:35.753Z" },
];
const la = { aixType: "property_recommendation", at: "2026-10-12T11:57:35.753Z" };
const now = Date.parse("2026-10-12T11:58:30Z");

{
  const r = resolvePostAixTurn({ messages: base, latestAix: la, nowMs: now });
  t("AIX の直後 → 続きの番（物件オススメ・🌟の本文）", r?.actionType === "property_recommendation" && /^🌟グランノーブル/.test(r.sentMessage), r);
}
t("2通目を送った後 → 番ではない", resolvePostAixTurn({ messages: [...base, { sender: "staff", text: "最寄り駅瓢箪山駅となりますがこちらのお部屋如何でしょうか！！", rawCreatedAt: "2026-10-12T12:01:06Z" }], latestAix: la, nowMs: now }) === null);
t("お客様が返した後 → 番ではない", resolvePostAixTurn({ messages: [...base, { sender: "customer", text: "いいですね", rawCreatedAt: "2026-10-12T12:00:00Z" }], latestAix: la, nowMs: now }) === null);
t("画像だけ足しても番のまま", resolvePostAixTurn({ messages: [...base, { sender: "staff", text: "[画像]", rawCreatedAt: "2026-10-12T11:59:00Z" }], latestAix: la, nowMs: now }) !== null);
t("次の日（日本時間）→ 番ではない", resolvePostAixTurn({ messages: base, latestAix: la, nowMs: Date.parse("2026-10-12T15:30:00Z") }) === null);
t("2通目を送らないと決めた AIX → 番ではない", resolvePostAixTurn({ messages: base, latestAix: { ...la, noSecond: true }, nowMs: now }) === null);
t("記録が無い → 番ではない", resolvePostAixTurn({ messages: base, latestAix: null, nowMs: now }) === null);
t("記録の AIX より前の本文（別の AIX）→ 番ではない", resolvePostAixTurn({ messages: base, latestAix: { ...la, at: "2026-10-12T12:30:00Z" }, nowMs: Date.parse("2026-10-12T12:31:00Z") }) === null);

t("状態: open", postAixTurnState(base).state === "open");
t("状態: AIX の本文が無い → unknown", postAixTurnState([{ sender: "staff", text: "[画像]", isAix: true }]).state === "unknown");
t("状態: 2通目の後 → closed", postAixTurnState([...base, { sender: "staff", text: "ご査収ください" }]).state === "closed");

t("直に入れるのは物件オススメだけ", postAixDirectTemplateOn("property_recommendation", undefined) && !postAixDirectTemplateOn("estimate_sheet", undefined) && !postAixDirectTemplateOn("property_recommendation", "off"));
t("記録から番を決める 既定 on", postAixTurnFromLogEnabled(undefined) && !postAixTurnFromLogEnabled("off"));
{
  const b = buildAixTemplateRequestBody({ actionType: "property_recommendation", actionCategory: "物件オススメ【AIX】", conversationId: "c", customerName: "YUMA", conversationState: "proposing", recentMessages: Array.from({ length: 30 }, (_, k) => ({ sender: "staff", text: String(k) })), customerConditions: "", customerSummary: null, noEmoji: false, pendingScheduledMessages: [{ text: "" }, { text: "a" }], staffMessagedToday: true, pickupType: null, lastAixCheckPattern: null, sentMessage: "🌟", sentMessageSource: "post_aix", ctaPreference: null });
  t("生成の本文: 直近15件・予約は文のある物だけ", (b.recentMessages as unknown[]).length === 15 && (b.pendingScheduledMessages as unknown[]).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
