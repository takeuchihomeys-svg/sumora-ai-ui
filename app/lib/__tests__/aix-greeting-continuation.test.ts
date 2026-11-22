// npx tsx app/lib/__tests__/aix-greeting-continuation.test.ts
// 2026-11-21 作業員L（確認事項 a56a67ab「続きの番は省く」を AIX の本体・2通目にも）
import assert from "node:assert/strict";
import { aixContinuationSkip } from "../greeting";
import { applyDailyGreeting } from "../daily-greeting";

// 前のこちらの文と同じ日にお客様が続けて送り、こちらの返事が翌日（その日最初の会話文）になった番＝続きの番
const cont = [
  { sender: "staff", text: "お部屋お送りさせて頂きます！！", rawCreatedAt: "2026-11-20T12:00:00Z" },
  { sender: "customer", text: "ありがとうございます、ここ気になります", rawCreatedAt: "2026-11-20T12:30:00Z" },
];
assert.equal(aixContinuationSkip(cont, {}), true); // 既定 on（竹内さん 11/21 改めて決定）
assert.equal(aixContinuationSkip(cont, { AIX_GREETING_CONTINUATION_SKIP: "off" }), false);
const ON = { AIX_GREETING_CONTINUATION_SKIP: "on" };
assert.equal(aixContinuationSkip(cont, ON), true);
assert.equal(aixContinuationSkip(cont, { ...ON, GREETING_CONTINUATION_SKIP: "off" }), false);
// お客様の発言が別の日（日をまたいで新しく来た）＝続きの番ではない＝今まで通り挨拶の番
assert.equal(aixContinuationSkip([cont[0], { ...cont[1], rawCreatedAt: "2026-11-21T01:00:00Z" }], ON), false);
// 初回（こちらの文が無い）は対象外
assert.equal(aixContinuationSkip([cont[1]], ON), false);
// 続きの番は「付けない／付いていれば外す」（staffSentToday=true の外す側を通す）
const d = applyDailyGreeting("〇〇さんお世話になっております！！\n🌟こちらのお部屋…", { staffSentToday: true, greetingPhrase: "", name: "" });
assert.equal(d.action, "removed");
console.log("aix-greeting-continuation: ok");
