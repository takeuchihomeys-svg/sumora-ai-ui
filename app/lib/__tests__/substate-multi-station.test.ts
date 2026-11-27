// app/lib/__tests__/substate-multi-station.test.ts — 細かい状態の出てよい駅を複数に（#804・SUBSTATE_MULTI_STATION・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/substate-multi-station.test.ts
import { SUBSTATES, substatesFor, substateStationsOf, substateAlsoHit, SUBSTATE_ALSO_AT, ALSO_MID_AIM } from "../apply-route-substate";
import { SWITCH_TARGET_MARK } from "../../../scripts/lib/exam-snapshot-need";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const ON = { SUBSTATE_MULTI_STATION: "on" }, OFF = {};
const LOCS = [...new Set(SUBSTATES.map((s) => s.at)), "hearing", "inquiry", "proposing", "pickup", "interested", "viewed"].flatMap((n) => [{ node: n, branch: null }, { node: "hearing", branch: n }]);
const oldFor = (loc: { node: string | null; branch: string | null }) => SUBSTATES.filter((s) => s.at === loc.branch || s.at === loc.node);
t("off: どの駅でも今の substatesFor と同じ（1バイトも変えない）", LOCS.every((l) => JSON.stringify(substatesFor(l, OFF)) === JSON.stringify(oldFor(l))));
t("off: 出てよい駅は置き場の駅1つ", substateStationsOf("apply_screening_worry", OFF).join() === "screening_concern");
t("on: 審査の不安はヒアリング・問い合わせ・気に入ったでも出る", ["hearing", "inquiry", "interested"].every((n) => substatesFor({ node: n, branch: null }, ON).some((s) => s.id === "apply_screening_worry")));
const sw = substatesFor({ node: "hearing", branch: null }, ON).find((s) => s.id === "apply_screening_worry")!;
t("on: 足した駅の審査の不安は今の1手だけ（次の2〜3番は駅の次の一手に従う・照らしで竹内さんは探す約束）", sw.midAim === ALSO_MID_AIM && sw.turnAim === SUBSTATES.find((s) => s.id === "apply_screening_worry")!.turnAim);
t("on: 置き場の駅ではそのまま", substatesFor({ node: "hearing", branch: "screening_concern" }, ON).find((s) => s.id === "apply_screening_worry")!.midAim !== ALSO_MID_AIM);
t("on: 検討しますは提案中・1件に好意は提案中とピックアップ（中身はそのまま）", substatesFor({ node: "proposing", branch: null }, ON).some((s) => s.id === "proposing_considering" && s.midAim !== ALSO_MID_AIM) && substatesFor({ node: "pickup", branch: null }, ON).some((s) => s.id === "proposing_liked_one"));
t("足した駅は表の3つだけ（2番以上出た駅）", Object.keys(SUBSTATE_ALSO_AT).sort().join() === "apply_screening_worry,proposing_considering,proposing_liked_one");
t("印: 足した駅で当たった時だけ・off は付かない", substateAlsoHit({ node: "hearing", branch: null }, ON) && !substateAlsoHit({ node: "hearing", branch: null }, OFF) && !substateAlsoHit({ node: "hearing", branch: "screening_concern" }, ON));
t("届きの印: SWITCH_TARGET_MARK に substate_multi_station", SWITCH_TARGET_MARK.SUBSTATE_MULTI_STATION === "substate_multi_station");
console.log(`substate-multi-station: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
