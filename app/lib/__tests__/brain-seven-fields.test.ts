// npx tsx app/lib/__tests__/brain-seven-fields.test.ts
import assert from "node:assert/strict";
import { brainSevenOn, brainSevenOutputItem, normalizeBrainSeven, normalizeBrainLatent } from "../brain-seven-fields";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, sentencePlanNote, readComposeContext, handoffLeaks } from "../compose-sentence-plan";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off＝ブレインの出力の指定は今と1文字も変わらない", () => {
  assert.equal(brainSevenOn({}), false);
  assert.equal(brainSevenOutputItem({}), "");
  assert.match(brainSevenOutputItem({ BRAIN_SEVEN_FIELDS: "on" }), /"seven_read".*"latent_read"/s);
});

const sevenRaw = {
  point: { what: "9/13まで空いているか", how: "埋まる可能性が高いと言い切る", skipped: null },
  bridge: { what: "撮影・オンライン内見で抑えた状態で13日以降に内覧", how: "時間枠を出す" },
  lead: "apply", appeal: { property: "スプランディッド難波WESTⅡ", point: "好条件", how: "同じ条件の方も申込む" },
  latent: { what: "9/13まで待つ間に埋まって逃す", fact: "同じ条件で探している方も申込む", how: "先に抑える道を出す" },
  point_how: ["assert", "name_property", "xxx"], trust_how: ["preempt", "effort"],
  push: { push: true, strength: "strong", reason: "物件の残り×日程を出した" },
};
const latentRaw = { trigger: { kind: "customer_words", text: "都合つくのが9月13日以降" }, part: { property: "スプランディッド難波WESTⅡ", point: "空き" }, feeling: { what: "待つ間に取られるのが怖い", strength: "mid" }, want: "内覧まで部屋を確保したい", fact: "同じ条件の方も申込む" };

t("読み取りは作業員5 の形（一覧の外の札は捨てる・壊れた物は null）", () => {
  const s = normalizeBrainSeven(sevenRaw)!;
  assert.equal(s.lead, "apply");
  assert.deepEqual(s.point_how, ["assert", "name_property"]);
  assert.equal(normalizeBrainSeven({ point: {} }), null);
  const l = normalizeBrainLatent(latentRaw)!;
  assert.equal(l.feeling.strength, "mid");
  assert.equal(normalizeBrainLatent({ none: true }), null);
});

t("本番の meta に入った形（入れ子の潜在）でも文の統括の設計図に漏れなく届く", () => {
  const meta = {
    seven_read: normalizeBrainSeven(sevenRaw), latent_read: normalizeBrainLatent(latentRaw),
    turn_contract: { asks: [{ quote: "今見てる物件埋まる可能性高いですかね", route: "reply", about: "vacancy", property: "スプランディッド難波WESTⅡ", answer: "好条件で埋まる可能性が高い" }] },
  };
  const note = sentencePlanNote(buildSentencePlan(readTurnUnderstanding(meta), readSevenFields(meta), { scene: "viewing", ctx: readComposeContext(meta) }));
  assert.deepEqual(handoffLeaks(meta, note), []);
  assert.match(note, /潜在: きっかけ 都合つくのが9月13日以降・何の部分 スプランディッド難波WESTⅡの 空き・気持ち 待つ間に取られるのが怖い（mid）・本当はしたい事 内覧まで部屋を確保したい/);
  assert.match(note, /訴求: スプランディッド難波WESTⅡの 好条件/);
  assert.match(note, /押す強さ: 強/);
});
console.log(`brain-seven-fields: ${n} pass`);
