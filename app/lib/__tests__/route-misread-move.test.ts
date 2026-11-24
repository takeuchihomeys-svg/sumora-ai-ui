// 統括の判断の「今どこ」× その後の一手（app/lib/route-misread-move.ts・台帳 #657）
// 実行: npx tsx app/lib/__tests__/route-misread-move.test.ts（全 PASS で exit 0）
import { parseAr, misreadMoveOf, misreadMoveMetricRows, replyAsMove } from "../route-misread-move";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
ok("digest.ar を読む", JSON.stringify(parseAr("viewing_arrange|negotiation|cost_over_budget|v2")) === JSON.stringify({ node: "viewing_arrange", branch: "negotiation", substate: "cost_over_budget" }) && parseAr("") === null);
ok("駅の次の一手なら合う（物件ピックアップ→物件を送る）", misreadMoveOf({ node: "pickup", branch: null, moveAix: "property_send", hoursAfter: 2 }).kind === "match");
const b1 = misreadMoveOf({ node: "pickup", branch: null, moveAix: "estimate_sheet", hoursAfter: 1, sentBefore: [] });
ok("地図が手前・前に先の駅の送付が無い＝材料が無い", b1.kind === "behind" && b1.cause === "material", b1);
const b2 = misreadMoveOf({ node: "pickup", branch: null, moveAix: "estimate_sheet", hoursAfter: 1, sentBefore: ["property_check_result"] });
ok("地図が手前・前に先の駅の送付がある＝読み違い", b2.kind === "behind" && b2.cause === "misread", b2);
ok("地図が先＝読み違い", misreadMoveOf({ node: "viewing_scheduled", branch: null, moveAix: "property_send", hoursAfter: 1 }).kind === "ahead");
ok("時刻で送る物・24時間より後は数え方（一手に数えない）", misreadMoveOf({ node: "pickup", branch: null, moveAix: "greeting_viewing", hoursAfter: 1 }).kind === "timed" && misreadMoveOf({ node: "pickup", branch: null, moveAix: "property_send", hoursAfter: 30 }).cause === "counting");
ok("返信だけは照らさない", misreadMoveOf({ node: "pickup", branch: null, moveAix: null, hoursAfter: null }).kind === "unknown");
ok("分かれ道の次の一手なら合う（持ち込み→物件確認した）", misreadMoveOf({ node: "inquiry", branch: "brought_property", moveAix: "property_check_result", hoursAfter: 1 }).kind === "match");
const m = misreadMoveMetricRows([{ kind: "match" }, { kind: "behind" }, { kind: "unknown" }, { kind: "timed" }]);
ok("毎朝の数は照らせた番だけで割る", m[0].metric === "route:station_misread_move" && m[0].value === 50 && m[0].n === 2, m);
ok("手打ちの返信の締めを一手として読む", replyAsMove("ご都合よろしいお日にちにお部屋ご案内させて頂きます！！") === "viewing_invite" && replyAsMove("御見積書を作成しお送りさせて頂きます") === "estimate_sheet" && replyAsMove("管理会社に募集状況確認させて頂きます") === "property_check_result" && replyAsMove("かしこまりました！！") === null && replyAsMove("") === null);
console.log(`route-misread-move: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
