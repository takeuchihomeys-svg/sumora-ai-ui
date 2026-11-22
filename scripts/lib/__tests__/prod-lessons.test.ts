// npx tsx scripts/lib/__tests__/prod-lessons.test.ts
// 2026-11-22 作業員L（台帳 #433 の案 B）: 本番の外れ → 学びの下書き（竹内さんの番だけ・道が同じなら作らない・まとめ）
import assert from "node:assert/strict";
import { prodLessonDraft, dedupeDrafts, isNightJst, type ProdMissTurn } from "../prod-lessons";

const base: ProdMissTurn = {
  watchId: 1, conv: "c1", at: "2026-11-20T03:00:00Z", type: "reply_not_aix", cause: "aix_turn_as_reply",
  staffWriter: "takeuchi", staffAix: ["property_check_result"], brainMode: "reply", brainAction: null,
  stage: "proposing", scene: null, mood: null, customerMasked: "お客様の文（伏せ済み）", staffHeadMasked: null,
};
const d = prodLessonDraft(base)!;
assert.equal(d.source, "prod:watch1"); assert.equal(d.source_conv, "c1");
assert.equal(d.expected_act, "AIX:property_check_result"); assert.equal(d.got_act, "返信");
assert.equal(d.miss_kind, "reply_vs_aix"); assert.equal(d.seed.cause, "AIX の番を返信にした");
assert.match(d.situation_text, /段階: proposing/);
// 竹内さん以外の番は作らない
assert.equal(prodLessonDraft({ ...base, staffWriter: "employee" }), null);
// 道が同じ（種類違いでない）なら作らない
assert.equal(prodLessonDraft({ ...base, type: "aix_kind", brainMode: "aix", brainAction: "property_check_result" }), null);
// 中身違いは道が同じでも作る（材料が届いていない）
const rc = prodLessonDraft({ ...base, type: "reply_content", cause: "material", staffAix: [], brainMode: "reply" })!;
assert.equal(rc.miss_kind, "material_missing"); assert.equal(rc.expected_act, "返信");
// まとめ: 同じ会話・同じ一手は1つ
assert.equal(dedupeDrafts([d, { ...d, source: "prod:watch2" }]).length, 1);
// 夜の判定（JST 23時は夜・JST 12時は昼）
assert.equal(isNightJst(Date.parse("2026-11-21T14:00:00Z")), true);
assert.equal(isNightJst(Date.parse("2026-11-21T03:00:00Z")), false);
console.log("prod-lessons: ok");
// 2026-11-22 統括役の頼み: 場面と両方の要点を問いに渡す・一般論は捨てる
import { prodLessonPrompt, keepProdLesson } from "../prod-lessons";
const dp = prodLessonDraft({ ...base, scene: "返信:条件提示", staffHeadMasked: "物件確認させて頂きます", draftHeadMasked: "かしこまりました" })!;
assert.equal(dp.scene, "返信:条件提示"); assert.match(String(dp.seed.why), /竹内さんの返信.*こちらの下書き/);
const pr = prodLessonPrompt(dp, { sceneJa: "返信:条件提示", staffHead: "物件確認させて頂きます", draftHead: "かしこまりました" });
assert.match(pr, /場面: 返信:条件提示/); assert.match(pr, /竹内さんの返信（伏せ済み）: 物件確認/); assert.match(pr, /こちらの下書き（伏せ済み）: かしこまりました/);
assert.equal(keepProdLesson("不明な場面ではまず確認を返す（なぜ: 誤案内を防ぐ）"), null);
assert.equal(keepProdLesson("差が読めない"), null);
assert.equal(keepProdLesson("条件提示の場面で物件の確認を頼まれた時は AIX の確認を先に（なぜ: 結果は人が知る事）"), "条件提示の場面で物件の確認を頼まれた時は AIX の確認を先に（なぜ: 結果は人が知る事）");
console.log("prod-lessons-prompt: ok");
