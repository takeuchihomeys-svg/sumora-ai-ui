// app/lib/__tests__/route-station-unify.test.ts — 地図の駅と判断の記録の駅をそろえる（2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/route-station-unify.test.ts
import { unifyStation, routeStationFromRecordOn } from "../route-station-unify";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("60日のずれの形: 地図ピックアップ・記録 提案中 → 提案中", unifyStation("pickup", "proposing").node === "proposing" && unifyStation("pickup", "proposing").changed);
t("記録が手前・同じなら地図のまま（戻さない）", unifyStation("proposing", "pickup").node === "proposing" && !unifyStation("estimate", "estimate").changed);
t("分かれ道の番・駅が分からない・申込は触らない", !unifyStation("pickup", "proposing", "brought_property").changed && !unifyStation(null, "proposing").changed && !unifyStation("apply_prep", "applying").changed);
t("既定 off", !routeStationFromRecordOn({}) && routeStationFromRecordOn({ ROUTE_STATION_FROM_RECORD: "on" }));
console.log(`route-station-unify: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
