// 申込までの地図の「今どこ」の読み違い（app/lib/route-station-misread.ts）
// 実行: npx tsx app/lib/__tests__/route-station-misread.test.ts（全 PASS で exit 0）
import { stationMisreadsOf, misreadMetricRowsOf, type MisreadRow } from "../route-station-misread";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const R = (o: Partial<MisreadRow>): MisreadRow => ({ conv: "c1", at: "2026-10-10T03:00:00Z", node: "proposing", branch: null, act: "reply:answer", rt: null, detail: null, ...o });

const a = stationMisreadsOf([
  R({ at: "2026-10-10T03:00:00Z", node: "proposing", act: "aix:estimate_sheet" }),
  R({ at: "2026-10-11T03:00:00Z", node: "proposing" }), // 見積を送った後なのに提案中
  R({ at: "2026-10-12T03:00:00Z", node: "estimate" }), // 正しい
]);
ok("見積の後なのに見積より前の駅", a.length === 1 && a[0].kind === "after_estimate" && a[0].at.startsWith("2026-10-11"), a);
ok("条件の言い直しの番は戻りが正しい（数えない）・その後も前の送付を忘れる", stationMisreadsOf([
  R({ at: "2026-10-10T03:00:00Z", act: "aix:estimate_sheet" }), R({ at: "2026-10-11T03:00:00Z", node: "pickup", rt: "condition_feedback" }), R({ at: "2026-10-12T03:00:00Z", node: "proposing" }),
]).length === 0);
ok("分かれ道の番は数えない", stationMisreadsOf([R({ act: "aix:estimate_sheet" }), R({ at: "2026-10-11T03:00:00Z", branch: "brought_property" })]).length === 0);
ok("30日より前の送付は数えない", stationMisreadsOf([R({ act: "aix:estimate_sheet" }), R({ at: "2026-11-20T03:00:00Z" })]).length === 0);
const b = stationMisreadsOf([R({ act: "aix:meeting_place", node: "viewing_arrange" }), R({ at: "2026-10-11T03:00:00Z", node: "estimate" })]);
ok("待ち合わせ場所の後なのに内覧予定より前（見積と重なる時は強い方1つ）", b.length === 1 && b[0].kind === "after_meeting_place", b);
ok("内覧の日が過ぎたのに内覧予定のまま", stationMisreadsOf([R({ node: "viewing_scheduled", at: "2026-10-29T03:00:00Z", detail: "10/28(水)17:00" })])[0]?.kind === "viewing_passed"
  && stationMisreadsOf([R({ node: "viewing_scheduled", at: "2026-10-27T03:00:00Z", detail: "10/28(水)17:00" })]).length === 0);
ok("会話をまたいで覚えない", stationMisreadsOf([R({ act: "aix:estimate_sheet" }), R({ conv: "c2", at: "2026-10-11T03:00:00Z" })]).length === 0);
ok("送付の記録（sentBefore）があれば、行に無い AIX の送付も前の送付として読む", stationMisreadsOf([R({ at: "2026-10-11T03:00:00Z", sentBefore: { estimate_sheet: "2026-10-10T05:00:00Z" } })])[0]?.kind === "after_estimate");
ok("条件の言い直しより前の送付の記録は読まない", stationMisreadsOf([
  R({ at: "2026-10-11T03:00:00Z", node: "pickup", rt: "condition_feedback", sentBefore: { estimate_sheet: "2026-10-10T05:00:00Z" } }),
  R({ at: "2026-10-12T03:00:00Z", node: "proposing", sentBefore: { estimate_sheet: "2026-10-10T05:00:00Z" } }),
]).length === 0);
const mr = misreadMetricRowsOf([R({ act: "aix:estimate_sheet" }), R({ at: "2026-10-11T03:00:00Z" }), R({ at: "2026-10-12T03:00:00Z", node: "estimate" }), R({ conv: "c3" })]);
ok("毎朝の1枚の行", mr[0].metric === "route:station_misread" && mr[0].value === 25 && mr[0].n === 4 && mr.find((x) => x.metric === "route:station_misread:after_estimate")?.value === 1);

console.log(`route-station-misread: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
