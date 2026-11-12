// npx tsx app/lib/__tests__/compose-element-types.test.ts
import assert from "node:assert/strict";
import { ELEMENT_TYPES, pickElementTypes, elementTypesOfText, elementTypesNote, composeElementTypesOn } from "../compose-order-table";
import { BRAIN_FIELD_ROUTE } from "../compose-sentence-plan";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off・off の時は注記を出さない", () => {
  assert.equal(composeElementTypesOn({}), false);
  assert.equal(elementTypesNote({ push_line: ["P_hold_first"], trust: [], latent_line: [] }, {}), "");
});
t("型を選ぶ欄は全部、ブレインの欄の受け口の表にある（新しい欄を型に使う時は先に受け口を作る）", () => {
  for (const e of ELEMENT_TYPES) for (const f of e.fields) assert.ok(f in BRAIN_FIELD_ROUTE, `${e.id}: ${f}`);
  assert.equal(new Set(ELEMENT_TYPES.map((e) => e.id)).size, ELEMENT_TYPES.length);
});
t("潜在＝先に取られる（customer_concern）＋訴求のタイミング＝申込 → 先に申込で抑える・すぐ埋まる", () => {
  const p = pickElementTypes({ customer_concern: { topic: "時期", object: "埋まる" }, appeal_timing: { kind: "apply", level: "suggest" } });
  assert.deepEqual(p.push_line, ["P_hold_first", "P_fill_soon"]);
});
t("潜在の4欄（審査で落ちて逃す）→ 独立系・別の保証会社", () => {
  const p = pickElementTypes({ latent_read: { trigger: { kind: "customer_words", text: "ブラックでも" }, part: { property: null, point: "審査" }, feeling: { what: "審査で落ちるのが怖い", strength: "strong" }, want: "通る部屋を知りたい", fact: null } });
  assert.deepEqual(p.latent_line, ["L_guarantor"]);
});
t("費用の潜在＋分割の問い → カードの分割（見積書ではない）・会社の事実", () => {
  const p = pickElementTypes({ customer_concern: { topic: "費用", object: "初期費用を分割したい" }, turn_contract: { asks: [{ route: "reply", about: "property_cost", answer: "カード払いのみ分割可・手数料3.24%" }] } });
  assert.deepEqual(p.latent_line, ["L_card"]);
  assert.deepEqual(p.trust, ["R_numbers", "R_company_fact"]);
});
t("竹内さんの文から型を読む（物差しの正解）", () => {
  const g = elementTypesOfText("保証会社審査承認後オーナー審査通過までキャンセル料かかりませんので、お部屋埋まる前に一度審査をかけて");
  assert.ok(g.push_line.includes("P_no_cancel_fee") && g.push_line.includes("P_fill_soon"));
  assert.ok(g.latent_line.includes("L_guarantor"));
});
t("on の注記は型の名前と竹内さんの数だけ（文は写さない）", () => {
  const note = elementTypesNote({ push_line: ["P_hold_first"], trust: ["R_quick"], latent_line: [] }, { COMPOSE_ELEMENT_TYPES: "on" });
  assert.match(note, /押す線: 先に申込で抑える（抑えた状態で内覧）（竹内さん 19通）｜信頼の作り方: すぐ動く約束/);
});
console.log(`compose-element-types: ${n} pass`);
