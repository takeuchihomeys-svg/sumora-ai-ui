// scripts/test-check-order.ts — 竹内さんの確認の順番の型の表（app/lib/check-order.ts）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-check-order.ts
import assert from "node:assert/strict";
import { CHECK_ORDER_TYPES, CHECK_DEPTH, TIE_BREAKS, pickCheckOrder, checkOrderNote, checkOrderMode, checkOrderById } from "../app/lib/check-order";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("型の id が重ならず・全部に深さ・なぜ・実例がある", () => {
  const ids = CHECK_ORDER_TYPES.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const x of CHECK_ORDER_TYPES) {
    assert.ok(CHECK_DEPTH[x.id], `深さが無い ${x.id}`);
    assert.ok(x.why.length > 20 && x.examples.length > 0 && x.cues.length > 0, x.id);
  }
});

t("道を決める前の確認は『今と後を分ける』を route より前に置く（AIX を先に選ばない）", () => {
  for (const x of CHECK_ORDER_TYPES) {
    const i = x.check.indexOf("now_vs_later"), r = x.check.indexOf("route");
    if (i >= 0 && r >= 0) assert.ok(i < r, x.id);
    // 重点・目的は道の後（q406・q057・q065）
    const f = x.check.indexOf("focus"), a = x.check.indexOf("aim");
    if (r >= 0 && f >= 0) assert.ok(r < f, `重点が道より前 ${x.id}`);
    if (r >= 0 && a >= 0) assert.ok(r < a, `目的が道より前 ${x.id}`);
  }
});

t("本番 12189 の形（条件の言い直し・未送付）＝条件の型で、今の番は返信の約束", () => {
  const p = pickCheckOrder({ conditionStated: true, pendingPromise: true });
  assert.equal(p[0].id, "T1_conditions_first");
  assert.match(checkOrderById(p[0].id)!.nowOutput, /^返信/);
});

t("結果が手元にある時は果たしが先（本番 11408）", () => {
  const p = pickCheckOrder({ resultReady: true, hasQuestion: true, answerableByFact: true });
  assert.equal(p[0].id, "T10_result_ready");
  assert.equal(p[1].id, "T2_question_fact");
});

t("初回の事情＋条件まだ＝返信が先・フォームは後（本番 12240・12306）", () => {
  const p = pickCheckOrder({ firstContact: true, conditionStated: false });
  assert.equal(p[0].id, "T11_first_contact_hearing");
});

t("物件が届いた＝何のためかを深く読む（本番 11264・11447）", () => {
  const p = pickCheckOrder({ customerSentProperty: true, conditionStated: true });
  assert.equal(p[0].id, "T4_property_shared");
  assert.equal(CHECK_DEPTH.T4_property_shared.base, "deep");
});

t("スタッフしか知らない問いは確認の約束の型・答えられる問いは答えの型", () => {
  assert.equal(pickCheckOrder({ hasQuestion: true, staffOnly: true })[0].id, "T3_question_staff_only");
  assert.equal(pickCheckOrder({ hasQuestion: true, staffOnly: false })[0].id, "T2_question_fact");
  assert.equal(pickCheckOrder({ hasQuestion: true, topic: "viewing" })[0].id, "T7_viewing");
});

t("検討の番は浅く読む（深く読むと押す材料で道を引っぱる）", () => {
  assert.equal(pickCheckOrder({ considering: true })[0].id, "T6_considering");
  assert.equal(CHECK_DEPTH.T6_considering.base, "shallow");
});

t("注記に道を決める言葉を入れない（AIX を選べ・押す等）", () => {
  for (const x of CHECK_ORDER_TYPES) {
    const s = checkOrderNote(x);
    assert.doesNotMatch(s, /AIX を選|aix=|を押してください/);
    assert.match(s, /なぜ: /);
  }
});

t("重なりの取り方は全部に理由と証拠", () => {
  for (const b of TIE_BREAKS) assert.ok(b.why && b.evidence, b.when);
});

t("既定 off", () => {
  const prev = process.env.CHECK_ORDER_TABLE;
  delete process.env.CHECK_ORDER_TABLE;
  assert.equal(checkOrderMode(), "off");
  process.env.CHECK_ORDER_TABLE = "shadow"; assert.equal(checkOrderMode(), "shadow");
  process.env.CHECK_ORDER_TABLE = "ON"; assert.equal(checkOrderMode(), "on");
  if (prev === undefined) delete process.env.CHECK_ORDER_TABLE; else process.env.CHECK_ORDER_TABLE = prev;
});

console.log(`全部 ${n} 件 ok`);
