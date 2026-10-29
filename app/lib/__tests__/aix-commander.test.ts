// app/lib/__tests__/aix-commander.test.ts — AIX の統括（候補・答えの整え・鍵→ボタン）（2026-10-29）
//   実行: npx tsx app/lib/__tests__/aix-commander.test.ts
import { aixDeskCommandMode, deskKeyOf, commanderCandidates, parseCommanderAnswer, actionOfKey, commanderUserText, AIX_COMMANDER_SYSTEM } from "../aix-commander";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, v?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(v)); } };
const keys = ["property_check_result/available", "property_check_result/mgmt_parking", "estimate_sheet/single", "estimate_sheet/multi", "acknowledge_check/daihyo_initial_cost", "meeting_place", "viewing_invite/通常", "viewing_invite/内覧日指定あり", "property_recommendation/新着1件", "property_send/new_arrival", "phone_call", "guarantor_info"];

t("既定は off", aixDeskCommandMode({}) === "off");
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
t("system に見分けの軸と also", AIX_COMMANDER_SYSTEM.includes("見分けの軸") && AIX_COMMANDER_SYSTEM.includes("also"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
