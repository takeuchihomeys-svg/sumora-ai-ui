// app/lib/__tests__/route-station-state.test.ts — 駅ごとの要る状態と足りない物の1行（2026-11-25 作業員A・#739）
//   実行: npx tsx app/lib/__tests__/route-station-state.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATION_NEEDS, missingNeeds, stationStateLine, stationStateLineOn } from "../route-station-state";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const now = Date.parse("2026-11-25T10:00:00Z");
t("表: 本線の駅に要る状態がある", ["inquiry", "hearing", "pickup", "proposing", "interested", "estimate", "viewing_arrange", "viewing_scheduled", "viewed"].every((k) => (STATION_NEEDS[k] ?? []).length > 0));
t("足りない物: 駅に入ってからの日数・見積書の後の通", missingNeeds().some((x) => x.key === "days_in_station") && missingNeeds().some((x) => x.key === "reply_after_estimate"));
const card = { estimate: { sentMinAgo: 120, checkMinAgo: null, checkResult: null, checkedBeforeEstimate: null } };
const l1 = stationStateLine({ node: "estimate", since: "2026-11-22T10:00:00Z", nowMs: now, messages: [{ sender: "customer", createdAt: "2026-11-25T09:30:00Z" }], card });
t("見積の駅: 日数と見積書の後の通あり", l1.includes("この駅に入って 3日") && l1.includes("見積書の後のお客様の通 あり"));
const l2 = stationStateLine({ node: "estimate", since: null, nowMs: now, messages: [{ sender: "customer", createdAt: "2026-11-25T07:00:00Z" }], card });
t("見積の駅: 見積書より前の通だけなら まだ無い", l2.includes("まだ無い") && !l2.includes("この駅に入って"));
t("足りない物が無い駅は空", stationStateLine({ node: "viewing_scheduled", since: "2026-11-22T10:00:00Z", nowMs: now, messages: [] }) === "" && stationStateLine({ node: null, since: null, nowMs: now, messages: [] }) === "");
t("既定 off", !stationStateLineOn({}) && stationStateLineOn({ STATION_STATE_LINE: "on" }));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ地図の文の後ろに", bc.includes("ss.stationStateLineOn() && ar.loc?.node && !ar.loc.branch") && bc.includes("materialMarks.station_state"));
console.log(`route-station-state: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
