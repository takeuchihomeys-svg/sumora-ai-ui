// 台帳 #795（作業員L 11/26）: 気持ち×駅 → 竹内さん本人の次の一手・地図が気持ちを読む1行（ROUTE_MINDSET_LINE・既定 off）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mindsetStationLine, routeMindsetLineOn, type StationMoveCell } from "../mindset-station-move";
import { cellsOf, stationAt } from "../../../scripts/audit-mindset-station-move";
import { readChainCounts, DECIDE_STATES } from "../../../scripts/audit-customer-read-chain";

assert.equal(routeMindsetLineOn({}), false);
const cells: StationMoveCell[] = [{ station: "estimate", state: "安くしたい", stone: { to: [], reply: [], aix: ["estimate_sheet"] }, move: "AIX:estimate_sheet", n: 6, share: 60 }];
assert.equal(mindsetStationLine("estimate", "迷い", cells), "", "マスが無ければ空");
assert.ok(mindsetStationLine("estimate", "安くしたい", cells).includes("AIX【estimate_sheet】 60%（6）"));
assert.equal(mindsetStationLine(null, "安くしたい", cells), "");
// 表の作り方
const c = cellsOf([...Array(4)].map(() => ({ station: "proposing", state: "迷い", move: "返信:answer" })).concat([{ station: "proposing", state: "迷い", move: "AIX:property_send" }]), 5);
assert.equal(c[0].move, "返信:answer"); assert.equal(c[0].share, 80); assert.deepEqual(c[0].stone.reply, ["answer"]);
assert.equal(cellsOf([{ station: "a", state: "b", move: "x" }], 5).length, 0, "番の少ないマスは出さない");
// 駅の当て方（段の時刻から）
const t = Date.parse("2026-11-10T00:00:00Z");
assert.equal(stationAt(t, { property_sent_at: "2026-11-01T00:00:00Z" }), "proposing");
assert.equal(stationAt(t, { property_sent_at: "2026-11-01T00:00:00Z", viewing_at: "2026-11-05T00:00:00Z" }), "viewing_scheduled");
assert.equal(stationAt(t, null), "inquiry");
// 決め手の残りの物差し（決めに行く場面の状態だけ）
const rc = readChainCounts([{ ms: "迷い|||予算:a" }, { ms: "普通の依頼|||" }, { ms: "安くしたい|||" }]);
assert.equal(rc.decideN, 2); assert.equal(rc.decideBlocker, 1); assert.ok(DECIDE_STATES.has("迷い"));
// 配線
const core = readFileSync(join(__dirname, "../brain-core.ts"), "utf8");
assert.ok(/msm\.routeMindsetLineOn\(\) && ar\.loc\?\.node/.test(core) && /materialBlocks\.push\(\{ key: "mindset_station"/.test(core));
console.log("mindset-station-move ok 15");
