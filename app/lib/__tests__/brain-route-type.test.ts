// app/lib/__tests__/brain-route-type.test.ts — 返信か AIX かの材料（実行: npx tsx app/lib/__tests__/brain-route-type.test.ts）
import { rules678FactsEnabled, RULE6_FACTS, RULE7_FACTS, RULE8_FACTS, isAixWritingRule, actionRulesJudgeOnlyEnabled } from "../brain-rules-facts";
import { routeTypeOf, pickRouteExamples, routeTypeBrainText, routeStatLine, routeTypeMaterialEnabled, routeTypeExamplesEnabled, type RouteExample } from "../brain-route-type";
import { ROUTE_EXAMPLES, ROUTE_TYPE_STATS } from "../brain-route-type-data";
import { lowPressNote, catalogBlockForBrain } from "../aix-catalog";
import { pickupPromiseOpen, pickupReadyMaterialLine, directPropertyNeedsPromise, overrideDemoted, samePromiseFamily, staffPromiseMaterialLine, applyOverride } from "../override-demote";
import { textFingerprint } from "../brain-judge-examples";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const ty = (c: string, prev = "", ack = false) => routeTypeOf({ customerText: c, prevStaffText: prev, ackOnly: ack });

// ── 型（候補の網）: 竹内さんの実送信の番の本文（伏せた）で
t("遅れる → late", ty("タクシー混んだおりギリギリです すみません。") === "late");
t("着きました → arrived", ty("到着しました。") === "arrived");
t("見送り → postpone_cancel", ty("申し訳ありません。\n転勤の件無くなりましたので今回は見送りでお願いします。") === "postpone_cancel");
t("インフル → postpone_cancel", ty("すみません今日病院いったらインフルと診断されて明日の内覧厳しくて💦\n改めて別日にお願いしたいです") === "postpone_cancel");
t("電話の時間 → phone_arrange", ty("かしこまりました！\n15時以降にお電話いたします！") === "phone_arrange");
t("時刻の変更 → time_change", ty("集合時間16:30か17:00に変更お願い出来ますでしょうか？？") === "time_change");
t("検討します → considering", ty("ありがとうございます。\n長居の方と悩んでいるので検討させていただきます。") === "considering");
t("検討＋問いは considering にしない", ty("検討します。ペットは何匹まで可能ですか？") !== "considering");
t("申込の意思 → apply_intent", ty("ファーイースト青谷審査出して欲しいです！") === "apply_intent");
t("申込の時期の問いは apply_intent にしない", ty("10月末入居希望だといつ頃申し込めばいいでしょうか？") !== "apply_intent");
t("URL の持ち込み → brought_property", ty("【SUUMO】大阪ひびきの街\nhttps://suumo.jp/x\nこの37階で23.2万の物件って募集本当に出てますか？") === "brought_property");
t("画面の文字（条件を変更する）で time_change にしない", ty("[画像] 21:14 ＜物件一覧 条件を変更する ドルチェ笹島 11.5万円") === "brought_property");
t("費用の問い → cost_question", ty("531,730これに駐車場もとめるとなれば11000円プラスって感じですか？？") === "cost_question");
t("空き・内覧の問い → vacancy_question", ty("内見はできない感じってことですかね？") === "vacancy_question");
t("保証の問い → screening_question", ty("住む本人が18歳の場合審査通らないと思うのですが保護者などでも大丈夫でしょうか？") === "screening_question");
t("他の物件 → other_property", ty("すみません、違う物件探して貰えますか？") === "other_property");
t("条件の足し → condition_feedback", ty("カウンターキッチン希望です") === "condition_feedback");
t("約束の後のお礼 → ack_after_promise", ty("ありがとうございます🙏🏻", "減額交渉をさせて頂きます！！結果分かり次第ご連絡させて頂きます😊！！", true) === "ack_after_promise");
t("内覧の段取りの後のお礼 → ack_after_viewing_setup", ty("よろしくお願いいたします！", "現地エントランスお待ち合わせで何卒よろしくお願い致します！！", true) === "ack_after_viewing_setup");
t("空 → null", ty("") === null);

// ── 手本の選び: 同じ会話・今の会話に出た発言の番は外す（試験の写しで答えが漏れない）・同じ道は2件まで
const mk = (o: Partial<RouteExample>): RouteExample => ({ conv: "c1", at: "2026-10-01T00:00:00Z", type: "considering", customer: "長居の方と悩んでいるので検討させていただきます", prev: "", actual: "返信", staff: "ごゆっくり", ...o });
const pool = [
  mk({ conv: "a", customer: "長居と天王寺で悩んでいるので検討させていただきます" }),
  mk({ conv: "b", customer: "旦那と相談して検討させていただきます", at: "2026-10-02T00:00:00Z" }),
  mk({ conv: "c", customer: "一度検討させていただきます", actual: "返信" }),
  mk({ conv: "d", customer: "検討させていただきます", actual: "AIX【条件ヒアリング】", staff: "" }),
  mk({ conv: "now", customer: "検討させていただきます" }),
];
const p1 = pickRouteExamples(pool, { type: "considering", customerText: "長居の方と悩んでいるので検討させていただきます", conversationId: "now" });
t("同じ会話の番は入れない", !p1.some((e) => e.conv === "now"));
t("同じ道（返信）は2件まで・対比の AIX が入る", p1.filter((e) => e.actual === "返信").length <= 2 && p1.some((e) => e.actual.startsWith("AIX")), JSON.stringify(p1.map((e) => e.conv)));
const p2 = pickRouteExamples([mk({ conv: "x", customer: "長居の方と悩んでいるので検討させていただきます", fp: [textFingerprint("最初にお送りした条件の文です。エリアは天王寺でお願いします")!] })],
  { type: "considering", customerText: "検討します", historyCustomerTexts: ["最初にお送りした条件の文です。エリアは天王寺でお願いします"] });
t("指紋が合う（写しの会話）番は入れない", p2.length === 0);
const p3 = pickRouteExamples(pool, { type: "late", customerText: "遅れます" });
t("型が違う手本は入れない", p3.length === 0);

// ── 材料の文
const txt = routeTypeBrainText("considering", { stats: { considering: { n: 23, reply: 17, promise: 4, aix: 2 } }, examples: p1 });
t("材料: 見分け・数・手本・ブレインが決める旨", /返信か AIX かの材料/.test(txt) && /返信 17/.test(txt) && /竹内さんの実送信（同じ型）/.test(txt) && /決めるのはこの会話の事実/.test(txt));
t("材料: 型が無ければ空", routeTypeBrainText(null) === "");
t("数は5番未満なら出さない", routeStatLine({ n: 3, reply: 1, promise: 1, aix: 1 }) === "");
t("既定 off・入れる: BRAIN_ROUTE_TYPE_MATERIAL=on", routeTypeMaterialEnabled({ BRAIN_ROUTE_TYPE_MATERIAL: "on" }) && !routeTypeMaterialEnabled({}));
t("BRAIN_ROUTE_TYPE_EXAMPLES=off は手本だけ", !routeTypeExamplesEnabled({ BRAIN_ROUTE_TYPE_MATERIAL: "on", BRAIN_ROUTE_TYPE_EXAMPLES: "off" }) && routeTypeExamplesEnabled({ BRAIN_ROUTE_TYPE_MATERIAL: "on" }));

// ── 作った data（竹内さんの番だけ・伏せた）
t("data: 手本がある", ROUTE_EXAMPLES.length > 50);
t("data: 数がある（条件・物件への感想は約束が多い）", (ROUTE_TYPE_STATS.condition_feedback?.promise ?? 0) > (ROUTE_TYPE_STATS.condition_feedback?.aix ?? 0));
t("data: 電話番号・メール・URL が無い", ROUTE_EXAMPLES.every((e) => !/0[789]0-?\d{4}-?\d{4}|[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\//.test(`${e.customer}${e.prev}${e.staff}`)));

// ── 押されない AIX の材料（aix-catalog）
t("lowPressNote: 保証会社・初期費用の説明・内覧挨拶", !!lowPressNote("guarantor_info", {}) && !!lowPressNote("cost_explain", {}) && !!lowPressNote("greeting_viewing", {}) && lowPressNote("estimate_sheet", {}) === "");
t("lowPressNote: 戻す BRAIN_AIX_LOW_PRESS_NOTE=off", lowPressNote("guarantor_info", { BRAIN_AIX_LOW_PRESS_NOTE: "off" }) === "");
t("ブレインの一覧に押された実績の行が出る（保証会社）", /押された実績（30日）: ブレインが選んだ 10番/.test(catalogBlockForBrain("question")));

// ── 物件の AIX を直接にする前の約束の有無（override-demote）
t("約束が開いている: 最後の約束がピックアップで、その後に送っていない", pickupPromiseOpen({ lastPromisedKind: "pickup_declared", lastPromisedAt: "2026-10-10T01:00:00Z", lastPropertiesSentAt: "2026-10-09T01:00:00Z" }));
t("約束は果たした: 約束の後に送った", !pickupPromiseOpen({ lastPromisedKind: "pickup_declared", lastPromisedAt: "2026-10-10T01:00:00Z", lastPropertiesSentAt: "2026-10-10T05:00:00Z" }));
t("今日もうピックアップを約束した", pickupPromiseOpen({ lastPromisedKind: "estimate_declared" }, ["pickup"]));
t("約束なし", !pickupPromiseOpen({ lastPromisedKind: null }));
t("材料の行: 送れる物件があり約束なし → まず約束の一文", /まだピックアップしてお送りする約束をしていない/.test(pickupReadyMaterialLine(true, false, {})));
t("材料の行: 約束あり・分からない → 旧の行", !/まだピックアップ/.test(pickupReadyMaterialLine(true, true, {})) && !/まだピックアップ/.test(pickupReadyMaterialLine(true, null, {})));
t("戻す: TWO_STAGE_DIRECT_NEEDS_PROMISE=off", !directPropertyNeedsPromise({ TWO_STAGE_DIRECT_NEEDS_PROMISE: "off" }) && !/まだピックアップ/.test(pickupReadyMaterialLine(true, false, { TWO_STAGE_DIRECT_NEEDS_PROMISE: "off" })));

// ── 10/14 #3 約束の AIX の差し替え（staff_promise）・#5 turn_route_guards の配線
t("staff_promise は既定で下げる・off で旧", overrideDemoted("staff_promise", {}) && !overrideDemoted("staff_promise", { BRAIN_DEMOTE_STAFF_PROMISE: "off" }));
t("turn_route_guards は既定で上書きのまま（今の動き）・on で下げる", !overrideDemoted("turn_route_guards", {}) && overrideDemoted("turn_route_guards", { BRAIN_DEMOTE_TURN_GUARDS: "on" }));
t("同じ族: 物件ピックアップの約束 × LLM の物件オススメ", samePromiseFamily("property_send", "property_recommendation"));
t("同じ族: 確認の約束 × 確認します", samePromiseFamily("property_check_result", "acknowledge_check"));
t("違う族: 見積の約束 × LLM の返信（null）・内覧調整", !samePromiseFamily("estimate_sheet", null) && !samePromiseFamily("estimate_sheet", "viewing_invite"));
t("材料: 約束なしは空", staffPromiseMaterialLine({}) === "");
t("材料: 確認と見積の約束", /確認（果たすのは AIX【物件確認した】/.test(staffPromiseMaterialLine({ confirmationPromisedUnfulfilled: true, estimatePromisedUnfulfilled: true })) && /御見積書/.test(staffPromiseMaterialLine({ estimatePromisedUnfulfilled: true })));
const dl: Parameters<typeof applyOverride>[0] = [];
t("下げた時は記録して false", applyOverride(dl, "staff_promise", "promise:check", "property_check_result", null, {}) === false && dl.length === 1 && dl[0].family === "staff_promise");
t("上書きのままの家族は true（記録なし）", applyOverride(dl, "turn_route_guards", "guard:not_pickup_turn", null, "property_send", {}) === true && dl.length === 1);

// ── 10/14 入口の洗い出し #3: 品質ルール⑥⑦⑧を事実の材料に（brain-rules-facts）
t("⑥⑦⑧の事実の材料: 既定 on・戻す BRAIN_RULES_678_FACTS=off", rules678FactsEnabled({}) && !rules678FactsEnabled({ BRAIN_RULES_678_FACTS: "off" }));
t("⑥: aix を null と決め打ちしない・竹内さんの数がある", !/aix フィールドは null にする/.test(RULE6_FACTS) && /36番＝23%/.test(RULE6_FACTS));
t("⑦: 弔事・病気のキャンセルの線は残す・お客様の恐縮とスタッフの文の語は外す", /弔事・病気/.test(RULE7_FACTS) && /恐縮/.test(RULE7_FACTS) && /スタッフ自身の文の語/.test(RULE7_FACTS));
t("⑧: 別物件の提案を禁止しない（代わりの物件・続けて1件の事実）", !/別物件の提案」を追加/.test(RULE8_FACTS) && /82%/.test(RULE8_FACTS));

// ── 10/14 入口の洗い出し #1: アクション別ルールは判断の行だけ
t("文の書き方の規則（DIFF-POLICY・構成・冒頭）は外す", isAixWritingRule({ rule_key: "DIFF-POLICY-AIX-1", rule_text: "x" }) && isAixWritingRule({ rule_key: "R1", rule_text: "冒頭は「お世話になっております」から書く" }));
t("判断の規則は残す", !isAixWritingRule({ rule_key: "R2", rule_text: "見積書の後の前向きな反応だけでは申込へを選ばない" }));
t("戻す BRAIN_ACTION_RULES_JUDGE_ONLY=off", actionRulesJudgeOnlyEnabled({}) && !actionRulesJudgeOnlyEnabled({ BRAIN_ACTION_RULES_JUDGE_ONLY: "off" }));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
