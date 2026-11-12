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
import { uptakePlan, uptakeNote } from "../compose-order-table";
t("送った部分の刺さり（作業員16 の受け口）→ 推す軸は広さを先に・強い刺さり×1部屋のみ＝先に抑える道・漏れ0", () => {
  const meta = {
    our_send_uptake: [{ property: "スプランディッド難波WESTⅡ", point: "家賃", strength: "mid", clue: "家賃が安い" }, { property: "スプランディッド難波WESTⅡ", point: "広さ（30㎡）", strength: "strong", clue: "広いですね" }, { property: null, point: "2階", strength: "weak", clue: "" }],
    turn_contract: { asks: [{ quote: "広いですね", route: "reply", about: "reaction_to_sent", answer: "1部屋のみの募集" }] },
  };
  const p = uptakePlan(meta)!;
  assert.deepEqual(p.axis, ["スプランディッド難波WESTⅡの広さ（30㎡）", "スプランディッド難波WESTⅡの家賃"]); // 階は推しの理由にしない
  assert.equal(p.lead, "apply"); assert.equal(p.pushLine, "P_hold_first");
  assert.equal(uptakeNote(p, {}), "");
  assert.match(uptakeNote(p, { COMPOSE_ELEMENT_TYPES: "on" }), /推す軸＝スプランディッド難波WESTⅡの広さ（30㎡）・.*次へ: 先に抑える道（申込）/);
  const note = spn(bsp(readTurnUnderstanding(meta), rsf(meta), { ctx: rcc(meta) }));
  assert.deepEqual(hl(meta, note), []);
  assert.equal(uptakePlan({}), null);
});
import { trustTurnOf, trustPhraseUsage, freshTrustPhrases, trustTurnNote, trustRepeatCount } from "../compose-order-table";
t("信頼をつなぐ番の見分け（初回・条件の番・不安を口にした）と、無い番は null", () => {
  assert.equal(trustTurnOf({ scene: "other", customerText: "", firstContact: true, meta: {} })?.id, "first_contact");
  assert.equal(trustTurnOf({ scene: "conditions", customerText: "家賃6万で", firstContact: false, meta: {} })?.id, "conditions");
  assert.equal(trustTurnOf({ scene: "question", customerText: "審査通るか心配です💦", firstContact: false, meta: {} })?.id, "anxious");
  assert.equal(trustTurnOf({ scene: "ack", customerText: "ありがとうございます", firstContact: false, meta: {} }), null);
});
t("言い回しの重なり避け: 直近のこちらの送信で使った核は続けず、まだ使っていない形を選ぶ", () => {
  const usage = trustPhraseUsage(["ご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！", "全力でサポートさせて頂きます！！"]);
  assert.equal(usage.get("全力で"), 2);
  const f = freshTrustPhrases("R_support", usage);
  assert.ok(!f.fresh.includes("全力で") && !f.fresh.includes("サポートさせて頂きます"));
  assert.deepEqual(f.fresh, ["出来る限り", "ご安心ください"]);
  const note = trustTurnNote({ scene: "conditions", customerText: "家賃6万で", firstContact: false, meta: {}, recentStaffTexts: ["全力でサポートさせて頂きます！！"] }, { COMPOSE_ELEMENT_TYPES: "on" });
  assert.match(note, /信頼をつなぐ番（条件の番（探す約束）・竹内さん 16\/22通）.*既に使った言い回し: サポートさせて頂きます 1回・全力で 1回→続けない。まだ使っていない形: ご満足頂くお部屋が見つかるまで／出来る限り/);
  assert.equal(trustTurnNote({ scene: "conditions", customerText: "", firstContact: false, meta: {}, recentStaffTexts: [] }, {}), "");
});
t("物差し: 下書きで同じ核が何回出たか", () => {
  const r = trustRepeatCount(["全力でサポートさせて頂きます", "全力でサポートさせて頂きます", "確認出来次第ご連絡させて頂きます"]);
  assert.equal(r[0].drafts, 2);
  assert.ok(r.some((x) => x.key === "確認出来次第" && x.drafts === 1));
});
import { readOurSendUptake, infoKindsOf } from "../compose-order-table";
t("作業員16 の our_send_uptake の形（hook・degree・point・cue）: 決めたい＝抑える・刺さらない＝探す約束・漏れ0", () => {
  const meta = { our_send_uptake: [{ part: "スプランディッド難波WESTⅡ 604号室", kind: "property", uptake: "answered", hook: "hooked", degree: "decide", point: "広さ・間取り", cue: "ここにしたいです" }], turn_contract: { asks: [{ quote: "ここにしたい", route: "reply", about: "reaction_to_sent" }] } };
  const u = readOurSendUptake(meta);
  assert.equal(u[0].strength, "strong"); assert.equal(u[0].hook, "hooked");
  const p = uptakePlan(meta)!;
  assert.equal(p.rule, "decide"); assert.equal(p.lead, "apply");
  const nh = uptakePlan({ our_send_uptake: [{ part: "〇〇", kind: "property", uptake: "answered", hook: "not_hooked", degree: null, point: "駅・場所", cue: "遠いですね" }] })!;
  assert.equal(nh.lead, "keep_send"); assert.deepEqual(nh.axis, []);
  const note = spn(bsp(readTurnUnderstanding(meta), rsf(meta), { ctx: rcc(meta) }));
  assert.deepEqual(hl(meta, note), []);
  assert.match(note, /送った部分の刺さり（ブレイン）: スプランディッド難波WESTⅡ 604号室の広さ・間取り:answered\/hooked\/decide\/「ここにしたいです」/);
});
t("作業員21 の情報の種類（K1〜K16）: K8 会社の事実→会社の事実の信頼・K14→信頼をつなぐ番・K15→先に抑える", () => {
  assert.deepEqual(infoKindsOf({ info_kind: [{ kind: "K8" }, "k14", { kind: "X" }] }), ["K8", "K14"]);
  const p = pickElementTypes({ info_kind: ["K8", "K15"] });
  assert.ok(p.trust.includes("R_company_fact")); assert.ok(p.push_line.includes("P_hold_first"));
  assert.equal(trustTurnOf({ scene: "question", customerText: "分割できますか", firstContact: false, meta: { info_kind: ["K14"] } })?.id, "anxious");
  const meta = { info_kind: ["K8"], turn_contract: { asks: [{ quote: "分割できますか", route: "reply", about: "procedure", answer: "カード払いのみ" }] } };
  assert.deepEqual(hl(meta, spn(bsp(readTurnUnderstanding(meta), rsf(meta), { ctx: rcc(meta) }))), []);
});
t("潜在の受け渡し（gold の外れの束）: 条件の番の concern は潜在にしない（q207）・気持ちの読みの不安の対象を潜在に（anxiety.target）", () => {
  const q207 = { customer_concern: { topic: "費用", object: "家賃管理費込みで5〜6万" }, turn_contract: { asks: [{ quote: "家賃管理費込みで5〜6万", route: "promise", about: "search_condition" }] } };
  assert.equal(rsf(q207).latentCover, null);
  const anx = { customer_mindset: { state: "迷い", anxiety: { target: "先に取られる", direction: "前向き" } }, turn_contract: { asks: [{ quote: "最短でも11月中旬ですか", route: "reply", about: "vacancy" }] } };
  assert.equal(rsf(anx).latentCover?.kind, "先に取られる");
  const note = spn(bsp(readTurnUnderstanding(anx), rsf(anx), { ctx: rcc(anx) }));
  assert.deepEqual(hl(anx, note), []);
});
import { howByType, composeHowByTypeOn } from "../compose-sentence-plan";
t("型ごとの「どうやって」の足し（COMPOSE_HOW_BY_TYPE・既定 off）: 検討＝都合に合わせる・物件が届いた＝言葉を拾う＋名指し・番の材料があれば触らない", () => {
  assert.equal(composeHowByTypeOn({}), false);
  assert.deepEqual(howByType("T6_considering", { hasAnswer: false, property: null }).trust, ["flexible"]);
  assert.deepEqual(howByType("T4_property_shared", { hasAnswer: false, property: "〇〇 101号室" }).key, ["echo_words", "name_property"]);
  assert.deepEqual(howByType("T7_viewing", { hasAnswer: true, property: null }).trust, ["flexible", "fact"]);
  const meta = { turn_contract: { asks: [], close_only: true } };
  const prev = process.env.COMPOSE_HOW_BY_TYPE; process.env.COMPOSE_HOW_BY_TYPE = "on";
  try {
    const p = bsp(readTurnUnderstanding(meta), rsf(meta), { scene: "considering" });
    assert.deepEqual(p.how?.trust, ["flexible"]);
    const withSeven = { ...meta, seven_read: { point: { what: "検討", how: "受ける" }, bridge: null, lead: "keep", appeal: null, latent: null, point_how: ["echo_words"], trust_how: ["support"], push: null } };
    assert.deepEqual(bsp(readTurnUnderstanding(withSeven), rsf(withSeven), { scene: "considering" }).how?.trust, ["support"]); // 番の材料が先
  } finally { if (prev == null) delete process.env.COMPOSE_HOW_BY_TYPE; else process.env.COMPOSE_HOW_BY_TYPE = prev; }
});
import { propertyNameRule, propertyNameNote, composeNamePropertyRuleOn } from "../compose-order-table";
t("物件名を出す線（COMPOSE_NAME_PROPERTY_RULE・既定 off）: お客様が言った時だけ・続き／束の中は出さない・同じ物件の部屋の比べは例外", () => {
  assert.equal(composeNamePropertyRuleOn({}), false);
  assert.equal(propertyNameRule({ property: "サンライト阿倍野8 202号室", customerText: "サンライト阿倍野8の202は子ども不可ですか？", recentStaffTexts: [] })?.say, true);
  assert.equal(propertyNameRule({ property: "エスリード中之島クロスゲート302号室", customerText: "最短でも入居可能日は11月中旬でしょうか？", recentStaffTexts: ["エスリード中之島クロスゲート302号室、現在募集中のお部屋となります！！"] })?.say, false);
  assert.equal(propertyNameRule({ property: "CRESTTAPP野田", customerText: "早めの引越しがいいので2階にしようかな？って思ってるんですけど虫関係で少し悩んでて", recentStaffTexts: ["2階は虫が入る可能性御座います"] })?.say, true);
  assert.equal(propertyNameRule({ property: null, customerText: "x", recentStaffTexts: [] }), null);
  assert.match(propertyNameNote({ property: "〇〇マンション 101号室", customerText: "初期費用いくらですか", recentStaffTexts: [] }, { COMPOSE_NAME_PROPERTY_RULE: "on" }), /文に書かない/);
  assert.equal(propertyNameNote({ property: "〇〇", customerText: "", recentStaffTexts: [] }, {}), "");
});
console.log(`compose-element-types: ${n} pass`);
