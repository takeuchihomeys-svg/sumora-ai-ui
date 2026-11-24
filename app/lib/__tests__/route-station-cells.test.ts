// 弱い駅を升に分ける（app/lib/route-station-cells.ts・台帳 #650）
// 実行: npx tsx app/lib/__tests__/route-station-cells.test.ts（全 PASS で exit 0）
import { stationCellsOf, stationCellSummary, sentStageOf, type CellRow } from "../route-station-cells";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const R = (o: Partial<CellRow>): CellRow => ({ node: "estimate", branch: null, rt: "cost_question", act: "reply:answer", agree: "push_missed", ...o });
const rep = (n: number, o: Partial<CellRow>) => Array.from({ length: n }, () => R(o));
{
  const cells = stationCellsOf([...rep(7, {}), ...rep(4, { act: "reply:invite_viewing", agree: "reply_invite" })], ["estimate"]);
  ok("n≥10 で竹内さんの多い方が過半数・地図と合うのが半分以下なら直しの候補", cells[0].verdict === "candidate" && cells[0].proposal?.act === "reply:answer" && cells[0].n === 11, cells);
}
ok("n が足りない升は n 不足（推して直さない）", stationCellsOf(rep(9, {}), ["estimate"])[0].verdict === "n_short");
ok("割れている升は割れ", stationCellsOf([...rep(5, {}), ...rep(5, { act: "aix:estimate_sheet" })], ["estimate"])[0].verdict === "split");
ok("地図と合う番が過半数なら直さない", stationCellsOf(rep(10, { agree: "aix_match" }), ["estimate"])[0].verdict === "already_ok");
ok("分かれ道は 分:〇〇 の駅で数える", stationCellsOf(rep(3, { branch: "screening_concern" }), ["分:screening_concern"], "rt", 2)[0].station === "分:screening_concern");
ok("送った物の段", sentStageOf({ sentBefore: { estimate_sheet: "x" } }) === "見積の後" && sentStageOf({ sentBefore: { property_send: "x" } }) === "物件の後" && sentStageOf({ sentBefore: {} }) === "送付なし" && sentStageOf({}) === "?");
ok("まとめ", stationCellSummary(stationCellsOf(rep(12, {}), ["estimate"]))[0].candidate === 1);
console.log(`route-station-cells: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
