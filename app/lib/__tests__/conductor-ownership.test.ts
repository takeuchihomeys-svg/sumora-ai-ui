// app/lib/__tests__/conductor-ownership.test.ts — 統括の受け持ち表（2026-11-26 作業員A・#662）
//   実行: npx tsx app/lib/__tests__/conductor-ownership.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownershipTable, OWN_ROWS } from "../conductor-ownership";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const ds = [
  { conv: "c1", at: "2026-11-26T00:00:00Z", digest: { mtk: "check_promise_flow,route_backplan", mpr: "mp-v2|o|r|check_promise_flow|", cpf: "a", aix: "property_check_result", bpn: "estimate" } },
  { conv: "c2", at: "2026-11-26T00:00:00Z", digest: { mtk: "check_promise_flow", mpr: "mp-v2|o|r|check_promise_flow|", cpf: "q", aix: "property_check_result" } },
  { conv: "c3", at: "2026-11-26T00:00:00Z", digest: { aix: "" } },
];
const ax = [{ conv: "c1", at: "2026-11-26T00:30:00Z", type: "property_check_result" }, { conv: "c1", at: "2026-11-26T05:00:00Z", type: "estimate_sheet" }];
const by = Object.fromEntries(ownershipTable(ds, ax).map((c) => [c.key, c]));
t("① 持つ: 材料の印のある番だけ数える", by.check_promise_flow.hold === 2 && by.route_backplan.hold === 1);
t("② 先頭・使った: ack_wait で物件確認した＝使った・問いの場面で AIX＝使わなかった", by.check_promise_flow.head === 2 && by.check_promise_flow.usedOk === 1 && by.check_promise_flow.usedOf === 2);
t("③ 反映: 目当ての AIX が2時間の内に出た（見積は5時間後＝反映していない）", by.check_promise_flow.reflectOk === 1 && by.check_promise_flow.reflectOf === 1 && by.route_backplan.reflectOk === 0 && by.route_backplan.reflectOf === 1);
t("欠け: 入口の駅は持つの印なし・境目と辞書は使ったの目印なし・駅の状態は決められない", by.intake_route.hold === null && by.intake_route.gaps.some((g) => g.startsWith("①")) && !by.aix_boundary.gaps.some((g) => g.startsWith("②")) && !by.aix_dictionary.gaps.some((g) => g.startsWith("②")) && by.station_state.gaps.some((g) => /決められない/.test(g)));
t("行: 今日までに作った部品が全部ある", ["intake_route", "route_backplan", "station_state", "check_promise_flow", "pickup_promise_flow", "aix_boundary", "aix_dictionary", "deal_flow_pre_apply"].every((k) => OWN_ROWS.some((r) => r.key === k)));
const bl = readFileSync(join(__dirname, "..", "brain-layers.ts"), "utf8");
t("記録: digest.mtk（材料の印のキー・DIGEST_MATERIAL_KEYS=off で止める）", bl.includes("o.mtk =") && bl.includes("DIGEST_MATERIAL_KEYS"));
import { USED_MARKERS } from "../material-priority";
t("#783 境目: 行どおり＝使った・逆＝使わなかった・欄なし＝決められない", USED_MARKERS.aix_boundary({ abd: "property_check_result", aix: "property_check_result" }) === true && USED_MARKERS.aix_boundary({ abd: "reply", aix: "property_send" }) === false && USED_MARKERS.aix_boundary({ abd: "reply", aix: "" }) === true && USED_MARKERS.aix_boundary({}) === null);
t("#783 辞書: 候補の AIX＝使った・別の AIX＝使わなかった・返信＝決められない", USED_MARKERS.aix_dictionary({ dct: "estimate_sheet+viewing_invite", aix: "viewing_invite" }) === true && USED_MARKERS.aix_dictionary({ dct: "estimate_sheet", aix: "property_send" }) === false && USED_MARKERS.aix_dictionary({ dct: "estimate_sheet", aix: "" }) === null);
t("#783 記録: abd・dct を digest に", bl.includes("o.abd = fm.abd") && bl.includes("o.dct = fm.dct"));
import { CONDUCTOR_DUTY } from "../../../scripts/lib/conductor-duty";
import { dutyPartLine } from "../conductor-ownership";
{ const all = CONDUCTOR_DUTY.flatMap((r) => r.partKeys ?? []); t("受け持ち表は1つ: 部品は全部どれか1つの土台の下", OWN_ROWS.every((r) => all.filter((k) => k === r.key).length === 1) && all.length === OWN_ROWS.length); }
t("土台の下の1行", dutyPartLine(["check_promise_flow"], ownershipTable(ds, ax)).includes("確認の約束の流れ 持つ 2・使った 1/2・反映 1/1") && dutyPartLine([], []) === "");
console.log(`conductor-ownership: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
