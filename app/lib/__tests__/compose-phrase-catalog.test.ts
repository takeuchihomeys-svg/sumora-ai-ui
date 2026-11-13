// npx tsx app/lib/__tests__/compose-phrase-catalog.test.ts
import assert from "node:assert/strict";
import { trustOfText, endingOf, trustFor, trustHowFor, endingsFor, phraseCatalogNote, composePhraseCatalogOn } from "../compose-phrase-catalog";

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
console.log(`compose-phrase-catalog: ${n} pass`);
