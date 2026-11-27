// 台帳 #795（作業員L 11/26）: 気持ち×駅 → 竹内さん本人の次の一手・地図が気持ちを読む1行（ROUTE_MINDSET_LINE・既定 off）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mindsetStationLine, routeMindsetLineOn, mindsetStationTopMark, chainRowsFromCells, type StationMoveCell } from "../mindset-station-move";
import { USED_MARKERS } from "../material-priority";
import { CHAIN_PATTERNS_REPLY } from "../chain-patterns-reply";
import { cellsOf, replyWordOf, stationAt, stoneOf } from "../../../scripts/audit-mindset-station-move";
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
assert.deepEqual(c[0].stone.to, ["interested", "estimate"], "to は NEXT_STONE の駅から");
assert.deepEqual(stoneOf("estimate", "AIX:viewing_invite"), { to: ["viewing_arrange", "apply_prep"], reply: [], aix: ["viewing_invite"] });
assert.deepEqual(stoneOf("applying", "返信:promise").to, [], "石の無い駅は空");
assert.equal(replyWordOf("確認して折り返しご連絡致します"), "promise");
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
// ① 使った目印（digest.msm）
const tc: StationMoveCell[] = [
  { station: "proposing", state: "迷い", stone: { to: [], reply: ["answer"], aix: [] }, move: "返信:answer", n: 14, share: 45.2 },
  { station: "proposing", state: "迷い", stone: { to: [], reply: ["promise"], aix: [] }, move: "返信:promise", n: 8, share: 25.8 },
  { station: "proposing", state: "内覧したい", stone: { to: [], reply: [], aix: ["viewing_invite"] }, move: "AIX:viewing_invite", n: 8, share: 40 },
  { station: "proposing", state: "内覧したい", stone: { to: [], reply: ["answer"], aix: [] }, move: "返信:answer", n: 6, share: 30 },
];
assert.equal(mindsetStationTopMark("proposing", "迷い", tc), "r:answer");
assert.equal(mindsetStationTopMark("proposing", "内覧したい", tc), "a:viewing_invite");
assert.equal(mindsetStationTopMark("proposing", "無い", tc), "");
const um = USED_MARKERS.mindset_station;
assert.equal(um({ msm: "a:viewing_invite", aix: "viewing_invite" }), true);
assert.equal(um({ msm: "a:viewing_invite", aix: "" }), false);
assert.equal(um({ msm: "r:answer", aix: "" }), true);
assert.equal(um({ msm: "r:answer", aix: "estimate_sheet" }), false);
assert.equal(um({ aix: "" }), null, "印の無い番は決められない");
assert.ok(/flowMarks\.msm = tm/.test(core) && /if \(fm\?\.msm\) o\.msm = fm\.msm/.test(readFileSync(join(__dirname, "../brain-layers.ts"), "utf8")), "印が digest まで届く");
// ② 連鎖の型の行（駅＋気持ち・駅だけより 20pt 以上・駅だけの割合は上に寄せた見積もり）
const cr = chainRowsFromCells(tc, 5, 5);
assert.ok(cr.every((r) => r.parts[1].startsWith("気持ち:") && /^(reply|aix):/.test(r.move)));
assert.ok(cr.some((r) => r.key === "proposing+気持ち:内覧したい" && r.move === "aix:viewing_invite"));
assert.ok(CHAIN_PATTERNS_REPLY.every((r) => r.lift >= 20 && r.n >= 5), "表の行は控えめの線を越えた物だけ");
console.log("mindset-station-move ok 31");
