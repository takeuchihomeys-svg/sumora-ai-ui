// npx tsx scripts/lib/__tests__/time-reply-scene.test.ts
// 2026-11-21 作業員L（台帳 #500 の下ごしらえ）: 場面と時の言葉への返し方の網（作った文）
import assert from "node:assert/strict";
import { timeSceneOf, timeHandlingOf, timeTurnOf, tallyTimeTurns } from "../time-reply-scene";

assert.equal(timeSceneOf("ありがとうございます！明日でも大丈夫です", { ourPropertyAix: false }), "short_thanks");
assert.equal(timeSceneOf("家族と相談して週末に連絡します", { ourPropertyAix: false }), "considering");
assert.equal(timeSceneOf("①【ご入居の時期】⇒11月末 ②【ご希望の家賃】⇒8万まで", { ourPropertyAix: false }), "conditions");
assert.equal(timeSceneOf("[画像] ここ12月から入れますか", { ourPropertyAix: false }), "property_brought");
assert.equal(timeSceneOf("来週見に行きたいです", { ourPropertyAix: true }), "property_send");

assert.equal(timeHandlingOf("かしこまりました！！明日一番に管理会社に確認させて頂きます！！", ["来週"]), "promise_due");
assert.equal(timeHandlingOf("11月末のご入居でかしこまりました！！", ["11月末"]), "restate_date");
assert.equal(timeHandlingOf("12/5(金)のご案内でいかがでしょうか", ["来週"]), "restate_date");
assert.equal(timeHandlingOf("かしこまりました！！お部屋ピックアップさせて頂きます！！", ["11月末"]), "no_touch");

const now = Date.parse("2026-11-21T03:00:00Z");
const t = timeTurnOf({ customerBurst: "入居は11月末くらいで考えています", atMs: now, reply: "11月末のご入居かしこまりました！！", ourPropertyAix: false });
assert.ok(t && t.scene === "considering" && t.handling === "restate_date", JSON.stringify(t));
assert.equal(timeTurnOf({ customerBurst: "ありがとうございます", atMs: now, reply: "はい！！", ourPropertyAix: false }), null);
const tab = tallyTimeTurns([t!]);
assert.equal(tab.considering.restate_date, 1);
console.log("time-reply-scene: ok");
