// npx tsx app/lib/__tests__/writer-decided-lines.test.ts
// 2026-11-21 作業員L（台帳 #466）: 書き手に届いていなかった欄（刺さった所・潜在の種類）と、AIX の2通目への1塊（事実の出所・こちら側・刺さった所）
import assert from "node:assert/strict";
import { writerHookedPressOn, writerLatentKindOn, aixSecondDecidedOn, writerHookedLine, writerLatentKindLine, aixSecondDecidedNote, factSourcesOf } from "../writer-decided-lines";
import { latentKindOf } from "../compose-sentence-plan";

for (const f of [writerHookedPressOn, writerLatentKindOn, aixSecondDecidedOn]) assert.equal(f({}), false);
assert.equal(writerHookedPressOn({ WRITER_HOOKED_PRESS: "on" }), true);

const meta = {
  our_send_uptake: [{ part: "家賃管理費込81,800円・岡町駅徒歩5分", kind: "property", uptake: "reacted", hook: "hooked", degree: "strong", point: "家賃", cue: "安い" }],
  three_layer: { worry: "審査に通るか不安" },
  turn_contract: { asks: [
    { quote: "礼金はいくらですか", route: "reply", answer: "礼金1ヶ月です", basis: "material" },
    { quote: "審査は何日くらい", route: "reply", answer: "3〜10日程", basis: "company_fact" },
    { quote: "空いてますか", route: "promise", answer: null, basis: "staff_only" },
  ] },
  our_side_note: "前の番で募集状況の確認を約束した（まだ）\n直前の AIX: 物件オススメ",
};

// ① 返信の書き手へ
assert.ok(writerHookedLine(meta).includes("「家賃」"), writerHookedLine(meta));
assert.ok(writerHookedLine(meta).includes("押さえの行"));
assert.equal(writerHookedLine({}), "");
const lk = writerLatentKindLine(meta, latentKindOf);
assert.ok(lk.startsWith("- 潜在の種類（ブレインの読み）: "), lk);
assert.equal(writerLatentKindLine({}, latentKindOf), "");

// ② AIX の2通目へ: 事実の出所（答えがある物だけ）・こちら側・刺さった所
assert.deepEqual(factSourcesOf(meta), [{ quote: "礼金はいくらですか", basis: "資料の値" }, { quote: "審査は何日くらい", basis: "会社の事実" }]);
const n = aixSecondDecidedNote(meta, { situationNoteOn: false });
assert.ok(n.includes("【ブレイン・統括が決めた事（2通目の材料・値のまま使う）】"));
assert.ok(n.includes("「礼金はいくらですか」は資料の値で"));
assert.ok(n.includes("- こちら側の状態: 前の番で募集状況の確認を約束した（まだ）"));
assert.ok(n.includes("- 刺さった所: 「家賃」"));
// K2 の SITUATION_WRITER_NOTE_AIX が on の時は、こちら側を外す（中身が重なる）
assert.ok(!aixSecondDecidedNote(meta, { situationNoteOn: true }).includes("こちら側の状態"));
assert.equal(aixSecondDecidedNote({}, { situationNoteOn: false }), "");

console.log("writer-decided-lines: ok");
