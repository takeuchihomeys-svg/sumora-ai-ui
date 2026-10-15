// app/lib/__tests__/override-demote.test.ts — 2026-10-13 決定論の上書きを材料＋食い違いのログに下げる
//   実行: npx tsx app/lib/__tests__/override-demote.test.ts
import { overrideDemoted, applyOverride, compactDemoted, DEMOTE_ENV, pickupReadyMaterialLine, brainContractSaysDirectPropertyAix, brainContractPromisesPickup, brainContractRejectsPromise, twoStageSourceDemotable, rawContractRouteDigest, closedAckMaterialLine, viewingDayAckMaterialLine, type DemotedOverride } from "../override-demote";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("既定は下げる（signal）", overrideDemoted("signal", {}));
t("BRAIN_DEMOTE_SIGNAL=off で旧の上書き", !overrideDemoted("signal", { BRAIN_DEMOTE_SIGNAL: "off" }));
t("家族ごとに別の環境変数", new Set(Object.values(DEMOTE_ENV)).size === Object.keys(DEMOTE_ENV).length);

// 本番の形: ブレインは AIX なし・信号は 物件ピックアップ（signal:property_send 0/20）
const list: DemotedOverride[] = [];
t("下げている時は上書きしない（false）", applyOverride(list, "signal", "signal:property_send", "property_send", null, {}) === false);
t("食い違いを残す", list.length === 1 && list[0].would === "property_send" && list[0].brain === null);
t("同じ src は1回", (applyOverride(list, "signal", "signal:property_send", "property_send", null, {}), list.length === 1));
t("ブレインと同じ答えは食い違いにしない", (applyOverride(list, "signal", "signal:scene_S10_phone_request", "phone_call", "phone_call", {}), list.length === 1));
t("戻した時は上書きする（true）・記録しない", applyOverride(list, "signal", "signal:scene_S8_cost_doubt", "cost_explain", null, { BRAIN_DEMOTE_SIGNAL: "off" }) === true && list.length === 1);
t("meta の形", JSON.stringify(compactDemoted(list)) === JSON.stringify([{ f: "signal", src: "signal:property_send", would: "property_send", brain: null }]));
t("空なら undefined", compactDemoted([]) === undefined);

// 4-3: 2段の約束
t("材料の行（候補あり／無し）", /直接出せる/.test(pickupReadyMaterialLine(true)) && /約束の返信/.test(pickupReadyMaterialLine(false)));
const direct = { asks: [{ quote: "新しいお部屋ありますか", route: "aix", aix: "property_send", topic: "物件の紹介" }] };
const promised = { asks: [{ quote: "大国町で1Kで", route: "promise", answer: "ご条件でピックアップしお送り", aix: "property_send" }] };
t("route=aix の物件の項目だけ → 直接", brainContractSaysDirectPropertyAix(direct, "property_send"));
t("約束の項目がある → 直接ではない", !brainContractSaysDirectPropertyAix({ asks: [...direct.asks, ...promised.asks] }, "property_send"));
t("約束だけ → 直接ではない", !brainContractSaysDirectPropertyAix(promised, "property_send"));
t("物件以外の AIX は対象外", !brainContractSaysDirectPropertyAix({ asks: [{ route: "aix", aix: "estimate_sheet" }] }, "estimate_sheet"));
t("turn_contract が無い → 直接ではない（安全側）", !brainContractSaysDirectPropertyAix(null, "property_send"));
// 棚卸しの表 2（10/13）: ブレインの本質が「約束しない」なら2段は上書きしない
t("閉じる番（close_only・約束なし）→ 下げる・close", (() => { const v = brainContractRejectsPromise({ asks: [{ route: "none" }], close_only: true }, {}); return v.reject && v.close; })());
t("答えるだけ（reply・閉じない）→ 既定は下げない（本番の例が無い）", !brainContractRejectsPromise({ asks: [{ route: "reply" }], close_only: false }, {}).reject);
t("答えるだけ（reply）→ TWO_STAGE_BRAIN_NO_PROMISE_REPLY=on で下げる・close でない", (() => { const v = brainContractRejectsPromise({ asks: [{ route: "reply" }], close_only: false }, { TWO_STAGE_BRAIN_NO_PROMISE_REPLY: "on" }); return v.reject && !v.close; })());
t("asks 空でも close_only → 下げる", brainContractRejectsPromise({ asks: [], close_only: "true" }, {}).reject);
t("約束の項目がある → 下げない", !brainContractRejectsPromise({ asks: [{ route: "reply" }, { route: "promise" }] }, {}).reject);
t("AIX の項目がある → 下げない（別の関所）", !brainContractRejectsPromise({ asks: [{ route: "aix", aix: "property_send" }] }, {}).reject);
t("本質が無い・中身が空 → 下げない（安全側）", !brainContractRejectsPromise(null, {}).reject && !brainContractRejectsPromise({ asks: [] }, {}).reject);
t("TWO_STAGE_BRAIN_NO_PROMISE=off で戻す", !brainContractRejectsPromise({ asks: [{ route: "none" }], close_only: true }, { TWO_STAGE_BRAIN_NO_PROMISE: "off" }).reject);
t("対象の種類", twoStageSourceDemotable("rule:two_stage_promise(pickup_unless_ack)") && twoStageSourceDemotable("rule:two_stage_promise(brought_both)") && !twoStageSourceDemotable("rule:two_stage_promise(work_support)") && !twoStageSourceDemotable("rule:two_stage_promise(viewing_check)") && !twoStageSourceDemotable("rule:two_stage_promise(room_photo_shoot)"));
t("生の道の数", rawContractRouteDigest({ asks: [{ route: "aix" }, { route: "promise" }], close_only: true }) === "2:r0p1a1n0:c" && rawContractRouteDigest(null) === null);
// 4-4: 締めの後のお礼
t("締めの材料の行に締めの文と実データ", /何時でもお気軽に/.test(closedAckMaterialLine("気になる点出てきましたら何時でもお気軽にご連絡ください😊")) && /返信しなかった 8/.test(closedAckMaterialLine("x")));
t("内覧当日の材料の行", /お気をつけて/.test(viewingDayAckMaterialLine("お気をつけてお越しください😊")) && /60件/.test(viewingDayAckMaterialLine("x")));
t("BRAIN_DEMOTE_VIEWING_DAY_ACK=off で戻す", !overrideDemoted("viewing_day_ack", { BRAIN_DEMOTE_VIEWING_DAY_ACK: "off" }) && overrideDemoted("viewing_day_ack", {}));
t("BRAIN_DEMOTE_CLOSED_ACK=off で戻す", !overrideDemoted("closed_ack_wait", { BRAIN_DEMOTE_CLOSED_ACK: "off" }) && overrideDemoted("closed_ack_wait", {}));




// 2026-10-15（q153）: ブレインが AIX を空にしてピックアップの約束（route=promise）を言った番
t("約束（送った物件への反応・ピックアップして送る）→ true", brainContractPromisesPickup({ asks: [{ route: "promise", about: "reaction_to_sent", answer: "予算10万円以内の物件を再度ピックアップして送ります" }] }, {}));
t("約束（探す条件・お部屋をお送り）→ true", brainContractPromisesPickup({ asks: [{ route: "promise", about: "search_condition", answer: "ペット可を外したお部屋をお送りする" }] }, {}));
t("確認・見積の約束・返信・about 無しは false", !brainContractPromisesPickup({ asks: [{ route: "promise", about: "vacancy", answer: "募集状況を確認する" }] }, {})
  && !brainContractPromisesPickup({ asks: [{ route: "promise", about: "reaction_to_sent", answer: "御見積書をお送りする" }] }, {})
  && !brainContractPromisesPickup({ asks: [{ route: "reply", about: "search_condition", answer: "ピックアップします" }] }, {})
  && !brainContractPromisesPickup({ asks: [{ route: "promise", answer: "ピックアップします" }] }, {}));
t("BRAIN_PROMISE_PICKUP=off で false", !brainContractPromisesPickup({ asks: [{ route: "promise", about: "search_condition", answer: "ピックアップします" }] }, { BRAIN_PROMISE_PICKUP: "off" }));
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
