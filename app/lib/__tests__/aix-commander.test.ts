// app/lib/__tests__/aix-commander.test.ts — AIX の統括（候補・答えの整え・鍵→ボタン）（2026-10-29）
//   実行: npx tsx app/lib/__tests__/aix-commander.test.ts
import { noteDecisions1103, takeDecisions1103, aixDeskAckApplyOn, hasAckPositiveApply, consultTriggers, aixDeskCommandMode, deskKeyOf, commanderCandidates, parseCommanderAnswer, actionOfKey, commanderUserText, AIX_COMMANDER_SYSTEM, deskCardsAsHits, DESK_EMPLOYEE_MARK } from "../aix-commander";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, v?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(v)); } };
const keys = ["property_check_result/available", "property_check_result/mgmt_parking", "estimate_sheet/single", "estimate_sheet/multi", "acknowledge_check/daihyo_initial_cost", "meeting_place", "viewing_invite/通常", "viewing_invite/内覧日指定あり", "property_recommendation/新着1件", "property_send/new_arrival", "phone_call", "guarantor_info"];

t("既定は shadow（記録だけ・11/03 夜）・off で止まる", aixDeskCommandMode({}) === "shadow" && aixDeskCommandMode({ AIX_DESK_COMMAND: "off" }) === "off");
t("shadow と on", aixDeskCommandMode({ AIX_DESK_COMMAND: "shadow" }) === "shadow" && aixDeskCommandMode({ AIX_DESK_COMMAND: "on" }) === "on");
t("鍵: ボタン＋ピッカー", deskKeyOf("property_check_result", "mgmt_parking", keys) === "property_check_result/mgmt_parking");
t("鍵: ボタンだけ→最初の札", deskKeyOf("estimate_sheet", null, keys) === "estimate_sheet/single");
t("鍵: 札の無いボタンは null", deskKeyOf("cost_explain", null, keys) === null);
const c1 = commanderCandidates("estimate_sheet/single", [], keys);
t("見積書には物件確認した（組の相手）を足す", c1[0] === "estimate_sheet/single" && c1.some((k) => k.startsWith("property_check_result")), c1);
const c2 = commanderCandidates("meeting_place", ["estimate_sheet"], keys);
t("待ち合わせ＋2つ目の見積書 → 内覧調整・物件確認した も", c2.includes("viewing_invite/通常") && c2.includes("estimate_sheet/single") && c2.some((k) => k.startsWith("property_check_result")), c2);
t("候補は6まで", commanderCandidates("property_check_result/available", ["meeting_place", "property_send", "guarantor_info"], keys).length <= 6);
const cands = ["meeting_place", "viewing_invite/通常", "estimate_sheet/single"];
t("答え: 鍵", parseCommanderAnswer({ pick: "viewing_invite/通常", also: ["estimate_sheet/single"], why: "日時なし" }, cands).pick === "viewing_invite/通常");
t("答え: also は候補の中だけ", JSON.stringify(parseCommanderAnswer({ pick: "meeting_place", also: ["estimate_sheet/single", "phone_call", "meeting_place"] }, cands).also) === '["estimate_sheet/single"]');
t("答え: promise は差し戻し", parseCommanderAnswer({ pick: "promise" }, cands).sendBack === "promise" && parseCommanderAnswer({ pick: "promise" }, cands).pick === null);
t("答え: reply は not_aix", parseCommanderAnswer({ pick: "reply" }, cands).sendBack === "not_aix");
t("答え: 候補に無い鍵は捨てる", parseCommanderAnswer({ pick: "cost_explain" }, cands).pick === null);
t("鍵→ボタン: 結果のピッカーは外す", JSON.stringify(actionOfKey("property_check_result/available")) === '{"action":"property_check_result","checkPattern":null}');
t("鍵→ボタン: 条件のピッカーは残す", actionOfKey("property_check_result/mgmt_parking").checkPattern === "mgmt_parking");
t("鍵→ボタン: 他のボタンはボタンだけ", JSON.stringify(actionOfKey("viewing_invite/通常")) === '{"action":"viewing_invite","checkPattern":null}');
t("user に候補の鍵と reply/promise", commanderUserText({ situationLine: "", conversation: "★お客様: x", cards: [{ key: "a", text: "■担当 a" }] }).includes("【候補の鍵】a / reply / promise"));
t("2026-11-04 帳面があれば状況のまとめの後・会話の前に入る", (() => { const u = commanderUserText({ situationLine: "S", conversation: "★お客様: x", cards: [{ key: "a", text: "■担当 a" }], ledgerBlock: "【このお客様の確かな事実の帳面（いつ・どこから）】- 物件 A を送った" }); return u.indexOf("【状況のまとめ】") < u.indexOf("事実の帳面") && u.indexOf("事実の帳面") < u.indexOf("【会話"); })());
t("帳面が無ければ今まで通り（帳面の見出しが出ない）", !commanderUserText({ situationLine: "", conversation: "★お客様: x", cards: [{ key: "a", text: "■担当 a" }] }).includes("帳面"));
t("No.21: 既定 on（11/06・=off で止める）", aixDeskAckApplyOn({}) && !aixDeskAckApplyOn({ AIX_DESK_ACK_APPLY: "off" }));
t("No.21: decisions_1103 に n21 がある番だけ", hasAckPositiveApply({ decisions_1103: ["n21", "n3"] }) && !hasAckPositiveApply({ decisions_1103: ["n2"] }) && !hasAckPositiveApply({}) && !hasAckPositiveApply(null));
noteDecisions1103("c1", ["n21"]);
t("No.21: 材料を渡した事実を受け取り・1回で消える", takeDecisions1103("c1").join() === "n21" && takeDecisions1103("c1").length === 0 && takeDecisions1103("c2").length === 0);
t("No.21: 相談のきっかけになる", consultTriggers({ contractAsksAixOrPromise: false, sceneUncertain: false, noGround: false, turnText: "ありがとうございます！", ackPositiveApply: true }).includes("ack_positive_apply"));
t("No.21: 材料が無ければお礼の番は相談しない", consultTriggers({ contractAsksAixOrPromise: false, sceneUncertain: false, noGround: false, turnText: "ありがとうございます！" }).length === 0);
t("system に見分けの軸と also", AIX_COMMANDER_SYSTEM.includes("見分けの軸") && AIX_COMMANDER_SYSTEM.includes("also"));
{ const cards = new Map([["a", "■a"], ["b", "■b " + DESK_EMPLOYEE_MARK + "従業員の番"], ["c", "■c"]]); const owners = new Map([["a", 4]]);
  const h = deskCardsAsHits(["a", "b", "c", "z"], cards, owners, "持ち込み");
  t("2026-11-04 ⑤(b) 札→SearchHit: 竹内さんの番がある札は takeuchi・従業員の候補だけは employee・無ければ template・札の無い鍵は外す", h.length === 3 && h[0].writer === "takeuchi" && h[1].writer === "employee" && h[2].writer === "template" && h[0].store === "aix_cards" && h[0].scene === "持ち込み" && (h[0].score ?? 0) > (h[1].score ?? 0)); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
