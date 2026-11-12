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
  assert.match(note, /押す線: 先に申込で抑える（抑えた状態で内覧）（取られる不安（決める前に埋まる）→先に確保できる＝急ぐ理由と安心・竹内さん 19通）｜信頼の作り方: すぐ動く約束/);
});

import { sentenceMeaningOf } from "../compose-order-table";
import { readTurnUnderstanding, readSevenFields as rsf, buildSentencePlan as bsp, sentencePlanNote as spn, readComposeContext as rcc, handoffLeaks as hl } from "../compose-sentence-plan";
t("文の意味: 竹内さんの1文が相手のどの不安・気持ちに効くか", () => {
  const a = sentenceMeaningOf("エスリード弁天町パークプレイスは1部屋のみの募集となりますので、お気に召されましたら申込でお部屋抑えるのがオススメです");
  assert.deepEqual(a.map((x) => x.id).sort(), ["P_hold_first", "P_one_room"]);
  assert.match(a.find((x) => x.id === "P_one_room")!.mind, /取られる不安/);
  assert.match(sentenceMeaningOf("独立系の保証会社をご利用のお部屋を中心に")[0].effect, /通る道がある＝安心/);
  assert.deepEqual(sentenceMeaningOf("かしこまりました！！"), []); // 型の言葉が無い文は付けない
});
t("信頼の作り方は潜在の4欄・3段からも選ぶ（ブレインに信頼の欄が無いため）", () => {
  assert.ok(pickElementTypes({ three_layer: { surface: "安いのはなぜ", worry: "安すぎて裏があるのでは", relief: "理由が分かる" } }).trust.includes("R_company_fact"));
  assert.ok(pickElementTypes({ latent_read: { feeling: { what: "掲載があるのに無いと言われ隠されていないか不安", strength: "mid" }, want: "本当の空きを知りたい" } }).trust.includes("R_honest"));
});
t("受け渡しの漏れ: 長い送ってきた動機・気にしている事も切らずに届く（60字で切っていた所）", () => {
  const long = "前の不動産屋で掲載していた物件が実はもう無いと言われた事があり、今回も送った5件が本当に空いているのか、また同じ事にならないか、急いで決めないといけないのか不安に思っている";
  const meta = { latent_intent: long, customer_concern: { topic: "募集状況", object: "掲載しているのに募集が無いと言われる物件が本当に空いているのか、また同じ事にならないかという不安" }, turn_contract: { asks: [{ quote: "空いてますか", route: "promise", about: "vacancy", property: "5件" }] } };
  assert.ok(long.length > 60);
  const note = spn(bsp(readTurnUnderstanding(meta), rsf(meta), { ctx: rcc(meta) }));
  assert.deepEqual(hl(meta, note), []);
});
console.log(`compose-element-types: ${n} pass`);
