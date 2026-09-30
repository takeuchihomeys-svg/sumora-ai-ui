// app/lib/__tests__/customer-complete-flow.test.ts
// 2026-09-30 v2.5.42 竹内「リアプロと itandi、お客さんそれぞれ同時に完了するようにする。YUMA ならリアプロと itandi 完了して、次のお客さんに移る…
//   そうすれば分析もお客さん毎に出来る」
//   ①AIXツールの一括検索: 1人1コマンドに リアプロ＋itandi（normalizeWebBrainSites・buildWebBrainCommands・後から押した itandi を pending の命令に足す planWebBrainFold）
//   ②売上サポのまとめ: そのお客様の検索が続いている間はまとめない（searchHold）＝両サイトがそろってから1回だけ解析・★物件出し★に1回
//   時刻は 2026-09-29 の ITANDI の実測（1回の中央値 6.5分・最長 25分・サイトの間 最長 95秒）に合わせた
// 実行: npx tsx app/lib/__tests__/customer-complete-flow.test.ts
import { normalizeWebBrainSites, buildWebBrainCommands, planWebBrainFold, webBrainBlockReason, queuedKey } from "../web-brain-search";
import { searchHold, SEARCH_HOLD_MAX_MS, NEXT_SITE_WAIT_MS, AUTO_COMPLETE_QUIET_MS, isQuietFor } from "../pickup-complete";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}
const NOW = Date.parse("2026-09-30T02:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

console.log("\n■ ① 1人1コマンドに両サイト");
{
  t("リアプロ＋itandi は並びをそろえて受ける", JSON.stringify(normalizeWebBrainSites(["itandi", "realnetpro"])) === JSON.stringify(["realnetpro", "itandi"]));
  t("1サイト・重複はそのまま", JSON.stringify(normalizeWebBrainSites(["itandi", "itandi"])) === JSON.stringify(["itandi"]) && JSON.stringify(normalizeWebBrainSites("reins")) === JSON.stringify(["reins"]));
  t("レインズとの組み合わせ・知らないサイト・空は受けない", normalizeWebBrainSites(["reins", "itandi"]) === null && normalizeWebBrainSites(["suumo"]) === null && normalizeWebBrainSites([]) === null);
  const { rows, skipped } = buildWebBrainCommands([{ id: "c1" }, { id: "c2" }, { id: "c3" }], ["realnetpro", "itandi"], false, { nowMs: NOW, queued: new Set([queuedKey("c2", "itandi"), queuedKey("c3", "realnetpro"), queuedKey("c3", "itandi")]) });
  t("1人1コマンドに sites 2つ・itandi だけ積んである人はリアプロだけ・両方積んである人は積まない", rows.length === 2 && JSON.stringify(rows[0].sites) === JSON.stringify(["realnetpro", "itandi"]) && JSON.stringify(rows[1].sites) === JSON.stringify(["realnetpro"]) && JSON.stringify(skipped) === JSON.stringify(["c3"]), rows);
  t("1サイトの呼び方は今まで通り", buildWebBrainCommands([{ id: "c1" }], "realnetpro", false, { nowMs: NOW }).rows[0].sites.length === 1);
  t("両サイトでも押せる人数の線は同じ（30人まで・レインズだけ1人）", webBrainBlockReason(5, ["realnetpro", "itandi"]) === null && webBrainBlockReason(2, ["reins"]) !== null);
  const pending = [
    { id: "p1", customer_ids: ["c1"], sites: ["realnetpro"], payload: { is_wide: false } },
    { id: "p2", customer_ids: ["c2"], sites: ["realnetpro"], payload: { is_wide: true } },
    { id: "p3", customer_ids: ["c4"], sites: ["realnetpro"], payload: { is_wide: false, search_override: { rent_max: 8 } } },
  ];
  const later = buildWebBrainCommands([{ id: "c1" }, { id: "c2" }, { id: "c4" }, { id: "c5" }], "itandi", false, { nowMs: NOW }).rows;
  const plan = planWebBrainFold(later, pending);
  t("後から押した itandi: まだ拾われていないリアプロの命令（同じピンポイント・上書きなし）に足す＝1人ずつ両サイトを続けて回す", plan.fold.length === 1 && plan.fold[0].commandId === "p1" && JSON.stringify(plan.fold[0].sites) === JSON.stringify(["realnetpro", "itandi"]), plan);
  t("広げてが違う・一時調整の上書き付き・命令の無い人は新しく積む", plan.insert.map((r) => r.customer_ids[0]).join(",") === "c2,c4,c5", plan.insert);
  t("同じサイトがもうあれば足さない", planWebBrainFold(buildWebBrainCommands([{ id: "c1" }], "realnetpro", false, { nowMs: NOW }).rows, pending).fold.length === 0);
}

console.log("\n■ ② 検索が続いている間はまとめない（3分の静けさ＋そのお客様の検索の様子）");
{
  const cmd = [{ id: "cmd1", status: "running", sites: ["realnetpro", "itandi"] }];
  // リアプロの回が 10:00 に始まり 10:04 に終わった。最後の物件は 10:04 に届いた。ITANDI はまだ始まっていない（サイトの間 8〜95秒）
  const rpDone = { created_at: iso(NOW - 8 * MIN), finished_at: iso(NOW - 4 * MIN), status: "finished", site: "realpro", command_id: "cmd1" };
  t("3分静かでも、同じ命令の ITANDI がまだ始まっていない（終わって4分以内）→ 待つ", searchHold([rpDone], cmd, NOW - 1 * MIN).hold && /next_site:itandi/.test(searchHold([rpDone], cmd, NOW - 1 * MIN).reason ?? ""));
  t("待つのは最後の回が終わってから NEXT_SITE_WAIT_MS（4分）まで（ITANDI のタブが無い PC で飛ばした時も、それを過ぎればまとめる）", !searchHold([rpDone], cmd, NOW + 1 * MIN).hold && NEXT_SITE_WAIT_MS === 4 * MIN);
  const itStarted = { created_at: iso(NOW - 2 * MIN), finished_at: null, status: "started", site: "itandi", command_id: "cmd1" };
  t("ITANDI の回が始まって終わっていない → 待つ（最長 30分）", searchHold([rpDone, itStarted], cmd, NOW).hold && searchHold([rpDone, itStarted], cmd, NOW).until === Date.parse(itStarted.created_at) + SEARCH_HOLD_MAX_MS);
  t("始まって 30分たっても終わらない回は見ない（止まった回で永久に待たない）", !searchHold([{ ...itStarted, created_at: iso(NOW - 31 * MIN) }], cmd, NOW).hold);
  const itDone = { ...itStarted, finished_at: iso(NOW - 1 * MIN), status: "finished" };
  t("両サイトとも終わった → 待たない（3分の静けさでまとまる）", !searchHold([rpDone, itDone], cmd, NOW).hold);
  t("命令が done なら次のサイトを待たない", !searchHold([rpDone], [{ id: "cmd1", status: "done", sites: ["realnetpro", "itandi"] }], NOW - 1 * MIN).hold);
  t("1サイトだけの命令（itandi 無し）→ 待たない", !searchHold([rpDone], [{ id: "cmd1", status: "running", sites: ["realnetpro"] }], NOW - 1 * MIN).hold);
  t("レインズは待つ相手にしない", !searchHold([rpDone], [{ id: "cmd1", status: "running", sites: ["realnetpro", "reins"] }], NOW - 1 * MIN).hold);
  t("点検の記録が無い（ブレインでない PC・古い版）→ 待たない＝今まで通り", !searchHold([], cmd, NOW).hold);
  t("止まった（abandoned）回は「始まっている」に数えない", !searchHold([{ ...itStarted, status: "abandoned", finished_at: null }], cmd, NOW).hold);
  t("3分の静けさの線は変えていない", AUTO_COMPLETE_QUIET_MS === 3 * MIN && isQuietFor(NOW - 3 * MIN, NOW) && !isQuietFor(NOW - 2 * MIN, NOW));
  // 実測に沿った通し: リアプロ 10:00〜10:04（物件 10:04）→ サイトの間 60秒 → ITANDI 10:05〜10:12（物件 10:12）
  const rp2 = { created_at: iso(NOW), finished_at: iso(NOW + 4 * MIN), status: "finished", site: "realpro", command_id: "cmd1" };
  const it2 = { created_at: iso(NOW + 5 * MIN), finished_at: null as string | null, status: "started", site: "itandi", command_id: "cmd1" };
  t("通し: 10:07（リアプロの物件から3分）は ITANDI の途中 → 待つ", searchHold([rp2, it2], cmd, NOW + 7 * MIN).hold);
  t("通し: 10:15（ITANDI が 10:12 に終わり物件が届いた後）→ 待たない＝1回だけまとまる", !searchHold([rp2, { ...it2, status: "finished", finished_at: iso(NOW + 12 * MIN) }], cmd, NOW + 15 * MIN).hold);

  // 2026-09-30 v2.5.43 同時の回: リアプロ 10:00 開始・ITANDI 10:00:10 開始（ずらし 3〜15秒）。どちらが先に終わっても、両方が終わるまで待つ
  const rpP = { created_at: iso(NOW), finished_at: null as string | null, status: "started", site: "realpro", command_id: "cmd1" };
  const itP = { created_at: iso(NOW + 10_000), finished_at: null as string | null, status: "started", site: "itandi", command_id: "cmd1" };
  t("同時: 両方が走っている → 待つ", searchHold([rpP, itP], cmd, NOW + 3 * MIN).hold);
  t("同時: リアプロが先に終わり ITANDI が途中 → 待つ", searchHold([{ ...rpP, status: "finished", finished_at: iso(NOW + 4 * MIN) }, itP], cmd, NOW + 8 * MIN).hold);
  t("同時: ITANDI が先に終わりリアプロが途中（終わる順が入れ替わる）→ 待つ", searchHold([rpP, { ...itP, status: "finished", finished_at: iso(NOW + 3 * MIN) }], cmd, NOW + 7 * MIN).hold);
  t("同時: 両方終わった（どちらの順でも）→ 待たない＝両サイトの後に1回",
    !searchHold([{ ...rpP, status: "finished", finished_at: iso(NOW + 9 * MIN) }, { ...itP, status: "finished", finished_at: iso(NOW + 5 * MIN) }], cmd, NOW + 13 * MIN).hold
    && !searchHold([{ ...rpP, status: "finished", finished_at: iso(NOW + 5 * MIN) }, { ...itP, status: "finished", finished_at: iso(NOW + 9 * MIN) }], cmd, NOW + 13 * MIN).hold);
  t("同時: ITANDI の回がまだ始まっていない一瞬（ずらしの間）にリアプロが終わっても → 待つ（next_site）", /next_site:itandi/.test(searchHold([{ ...rpP, status: "finished", finished_at: iso(NOW + 5_000) }], cmd, NOW + 6_000).reason ?? ""));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
