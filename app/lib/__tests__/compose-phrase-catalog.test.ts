// npx tsx app/lib/__tests__/compose-phrase-catalog.test.ts
import assert from "node:assert/strict";
import { trustOfText, endingOf, trustFor, trustHowFor, endingsFor, phraseCatalogNote, composePhraseCatalogOn, formSlotsNote, lengthFor, emojiFor, composeFormSlotsOn } from "../compose-phrase-catalog";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("信頼の作り方を竹内さんの文から決まった語で読む", () => {
  assert.deepEqual(trustOfText("管理会社に確認させて頂きます！！確認出来次第ご連絡させて頂きます！！"), ["effort", "deadline"]);
  assert.deepEqual(trustOfText("審査通過しやすい独立系の保証会社となります！！"), ["effort", "fact"].filter((x) => x !== "effort"));
  assert.ok(trustOfText("ご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます").includes("support"));
});
t("文の終わりの言い方を束ねる（いただ／頂・絵文字・記号は同じに）", () => {
  assert.equal(endingOf("募集状況確認させていただきます😊！！"), "確認させて頂きます");
  assert.equal(endingOf("家賃管理費込65,000円のお部屋となります！！"), "となります");
  assert.equal(endingOf("ありがとう"), null);
});
t("表を引く（場面×主の役目・少ない時は場面 * に落とす）", () => {
  const r = trustFor("question", "promise");
  assert.ok(r && r.n >= 1 && r.shares.length > 0);
  assert.ok(trustHowFor("question", "promise").includes("effort"));
  assert.equal(trustFor(null, null), null);
  assert.ok(endingsFor("ack", "close")?.top[0]?.[0] === "よろしくお願い致します");
});
t("既定 off は何も足さない・on で札と割合だけ（文は写さない）", () => {
  assert.equal(composePhraseCatalogOn({}), false);
  assert.equal(phraseCatalogNote({ scene: "question", mainRole: "promise", roles: ["uke", "promise"] }, {}), "");
  const s = phraseCatalogNote({ scene: "question", mainRole: "promise", roles: ["uke", "promise"] }, { COMPOSE_PHRASE_CATALOG: "on" });
  assert.match(s, /^- 信頼の作り方（竹内さんの同じ場面×主の役目 \d+番）: /);
  assert.match(s, /文の終わりの言い方/);
  assert.doesNotMatch(s, /{名前}|YUMA/);
  assert.match(s, /受け＝「かしこまりました」/);
});
t("形の欄（COMPOSE_FORM_SLOTS・既定 off）: 長さ・絵文字・期日の言葉", () => {
  assert.equal(composeFormSlotsOn({}), false);
  assert.ok((lengthFor("question", "promise")?.median ?? 0) >= 1);
  assert.ok(emojiFor("considering")?.kinds.every((k) => ["😊", "😌", "🌟", "✨"].includes(k)));
  assert.equal(formSlotsNote({ scene: "question", mainRole: "promise", dates: [] }, {}), "");
  assert.match(formSlotsNote({ scene: "question", mainRole: "promise", dates: [] }, { COMPOSE_FORM_SLOTS: "on" }), /^- 形: 長さ .*期日の言葉（明日中・本日中 等）は書かない/);
  assert.match(formSlotsNote({ scene: "question", mainRole: "promise", dates: ["11月中旬"] }, { COMPOSE_FORM_SLOTS: "on" }), /材料にある物だけ（11月中旬）/);
});
console.log(`compose-phrase-catalog: ${n} pass`);
