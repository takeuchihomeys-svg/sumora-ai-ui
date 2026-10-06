// app/lib/__tests__/confirm-promise-object.test.ts — 確認の約束の要件をお客様の質問から読み、AIX【確認した（条件・交渉）→管理会社に確認した→〈要件〉】を立てる
// 実行: npx tsx app/lib/__tests__/confirm-promise-object.test.ts
// 2026-10-06 ⑫ 竹内さん（チンシャン・スモラ 10/06）「これ確認したら連絡なので、AIXの確認したがセットされた状態にする…
//   AIXの物件確認したではなくて、確認したの管理会社に確認したの部分からスタッフが確認して送る形」
import { buildActionLedger, confirmObjectFromCustomerTurn, checkPatternForConfirmTopic, classifyStaffTextFacts, fillConfirmObjectFromCustomer } from "../action-ledger";
import { resolveStaffPromiseAix } from "../aix-task-link";
import { promiseCheckPatternOf, promiseEventRows } from "../promise-calendar";
import { resolveTwoStage } from "../two-stage";
import { customerRequestedPropertyCheck } from "../aix-scene-evidence";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// チンシャンの実物（10/05〜10/06・名前はそのまま会話の表示名）
const MSGS = [
  { sender: "staff", text: "DWELL ASANO 0020号室\n52㎡のゆとりある広さ・南向きで日当たり良好・インターネット無料で、チンシャンさんにかなりオススメ出来るお部屋となります😊！！\nお気に召されましたらお部屋ご案内させて頂きます！！\nお手隙の際にご査収ください😌！！", createdAt: "2026-10-04T05:40:00Z" },
  { sender: "customer", text: "ありがとうございます😊", createdAt: "2026-10-05T03:32:00Z" },
  { sender: "customer", text: "こちら畳は変えて頂けるのですか？？", createdAt: "2026-10-05T06:15:00Z" },
  { sender: "staff", text: "チンシャンさん\nお世話になっております！！\n和室につきまして管理会社へ確認させて頂きました！！\n和室は洋室への変更は出来ないお部屋となっております！！\n\n全部屋洋室の物件でチンシャンさんにオススメ出来るご条件のお部屋確認させて頂きます！！", createdAt: "2026-10-05T07:05:00Z" },
  { sender: "staff", text: "こちらのお部屋如何でしょうか！！\n\nリノベーション済みの角部屋で南向き・エアコン3基新設と設備も充実しており、チンシャンさんにかなりオススメ出来るお部屋となります！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！\nお手隙の際にご査収ください😊！！", createdAt: "2026-10-05T07:25:00Z" },
  { sender: "customer", text: "いいですね！", createdAt: "2026-10-05T10:46:00Z" },
  { sender: "customer", text: "これは畳を新品に出来るかをお聞きしました！\nややこしくてすみません💦", createdAt: "2026-10-06T01:16:00Z" },
  { sender: "staff", text: "チンシャンさんお世話になっております！！\nかしこまりました😊！！\n確認出来次第ご連絡させて頂きます！！", createdAt: "2026-10-06T02:13:00Z" },
  { sender: "customer", text: "ありがとうございます😊", createdAt: "2026-10-06T02:13:50Z" },
];

{
  const hit = confirmObjectFromCustomerTurn("これは畳を新品に出来るかをお聞きしました！\nややこしくてすみません💦");
  t("お客様の質問「畳を新品に出来るか」→ 要件 設備・質問の文", hit?.object === "設備" && /畳を新品/.test(hit?.question ?? ""), JSON.stringify(hit));
  t("設備 → check_pattern mgmt_equipment", checkPatternForConfirmTopic("設備") === "mgmt_equipment");
  t("募集状況 → 物件確認した側（null）", checkPatternForConfirmTopic("募集状況") === null);
  t("質問の形の無いお礼だけは読まない", confirmObjectFromCustomerTurn("ありがとうございます😊") === null);
  t("ペット飼えますか → ペット", confirmObjectFromCustomerTurn("猫1匹飼えますか？")?.object === "ペット");
  t("駐車場空いてますか → 駐車場", confirmObjectFromCustomerTurn("駐車場って空きありますか？")?.object === "駐車場");
}
{
  // 約束の文だけでは要件が無い（旧: 【必ず】確認事項・AIX 物件確認した）
  const f = classifyStaffTextFacts(MSGS[7].text, null).find((e) => e.kind === "confirmation_promised")!;
  t("約束の文だけ → 要件なし（旧の形）", f && !f.detail.object, JSON.stringify(f?.detail));
  fillConfirmObjectFromCustomer(f, MSGS, 7);
  t("直前のお客様の連投から要件を埋める", f.detail.object === "設備" && f.detail.objectFrom === "customer", JSON.stringify(f.detail));
  const rows = promiseEventRows([f], { conversationId: "c", customerName: "チンシャン", sentAt: "2026-10-06T02:13:00Z" });
  const notes = String((rows as Array<{ notes?: string }>)[0]?.notes ?? "");
  t("【必ず】の行は 設備の確認→ご連絡・AIX 確認した（条件・交渉）→設備", /設備の確認→ご連絡/.test(notes) && /確認した（条件・交渉）→設備/.test(notes), notes);
  t("【必ず】から開くピッカー → mgmt_equipment", promiseCheckPatternOf(notes) === "mgmt_equipment");
  t("物件確認した の行はピッカーを選ばない", promiseCheckPatternOf("【必ず】募集状況の確認→ご連絡\nAIX: 【物件確認した（確認結果を送る）】を送ったら完了") === null);
}
{
  // 台帳 → 約束の AIX（お客様のお礼の番）
  const ledger = buildActionLedger({ messages: MSGS, now: Date.parse("2026-10-06T02:14:00Z") });
  const e = ledger.facts.lastStaffEntry;
  t("台帳の直前のこちらの発言 = 確認の約束・要件 設備（お客様から）", e?.kind === "confirmation_promised" && e.detail.object === "設備" && e.detail.objectFrom === "customer", JSON.stringify(e));
  t("確認の約束は未報告", ledger.facts.confirmationPromisedUnfulfilled === true);
  const requested = customerRequestedPropertyCheck({ recentMessages: MSGS.slice(0, 8), sentPropertyCount: ledger.facts.propertiesSentCount });
  const p = resolveStaffPromiseAix(ledger.facts, MSGS, { customerRequestedCheck: requested, customerAckAfter: true });
  t("お礼の番 → AIX 確認した（property_check_result・mgmt_equipment）", p?.action === "property_check_result" && p.kind === "check" && p.checkPattern === "mgmt_equipment", JSON.stringify({ p, requested }));
  t("約束を果たす番は2段にしない（AIX のまま）", resolveTwoStage({ finalAix: "property_check_result", decisionSource: "promise:check", pickupReady: false, postApply: false }) === null);
}
{
  // 要件がお客様の質問からも読めない約束（「確認出来次第ご連絡」だけ・お客様はお礼だけ）は今まで通り（物件確認の依頼がある時だけ）
  const msgs = [
    { sender: "customer", text: "よろしくお願いします", createdAt: "2026-10-06T01:00:00Z" },
    { sender: "staff", text: "かしこまりました😊！！\n確認出来次第ご連絡させて頂きます！！", createdAt: "2026-10-06T01:05:00Z" },
    { sender: "customer", text: "ありがとうございます", createdAt: "2026-10-06T01:06:00Z" },
  ];
  const ledger = buildActionLedger({ messages: msgs, now: Date.parse("2026-10-06T01:07:00Z") });
  t("要件が読めない約束は要件を作らない", !ledger.facts.lastStaffEntry?.detail.object, JSON.stringify(ledger.facts.lastStaffEntry?.detail));
  t("要件が読めない・依頼もない → 約束の AIX を立てない（今まで通り）", resolveStaffPromiseAix(ledger.facts, msgs, { customerRequestedCheck: false, customerAckAfter: true }) === null);
}

{ // 2026-10-06 竹内さん（質問3「セットする」）: スタッフの文に要件がある約束も、お礼の番に 確認した→管理会社に確認した→〈要件〉
  const msgs = [
    { sender: "customer", text: "猫を1匹飼っているのですが大丈夫でしょうか？", createdAt: "2026-10-06T01:00:00Z" },
    { sender: "staff", text: "かしこまりました！！\nペット飼育可能か管理会社に確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😊！！", createdAt: "2026-10-06T01:05:00Z" },
    { sender: "customer", text: "ありがとうございます！", createdAt: "2026-10-06T01:06:00Z" },
  ];
  const ledger = buildActionLedger({ messages: msgs, now: Date.parse("2026-10-06T01:07:00Z") });
  const p = resolveStaffPromiseAix(ledger.facts, msgs, { customerRequestedCheck: false, customerAckAfter: true });
  t("スタッフの文に要件（ペット）→ お礼の番に 確認した（mgmt_pet）", p?.action === "property_check_result" && p.checkPattern === "mgmt_pet", JSON.stringify({ p, e: ledger.facts.lastStaffEntry }));
  const msgs2 = [
    { sender: "customer", text: "初期費用どれくらいですか？", createdAt: "2026-10-06T01:00:00Z" },
    { sender: "staff", text: "初期費用確認させて頂き、御見積書お送りさせて頂きます！！", createdAt: "2026-10-06T01:05:00Z" },
    { sender: "customer", text: "お願いします", createdAt: "2026-10-06T01:06:00Z" },
  ];
  const l2 = buildActionLedger({ messages: msgs2, now: Date.parse("2026-10-06T01:07:00Z") });
  const p2 = resolveStaffPromiseAix(l2.facts, msgs2, { customerRequestedCheck: false, customerAckAfter: true, propertyInPlay: true });
  t("初期費用＋御見積書の約束 → 確認した ではない（見積書の流れ）", p2?.checkPattern !== "mgmt_initial_cost", JSON.stringify(p2));
}
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
