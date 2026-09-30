// app/lib/__tests__/itandi-guard-check.test.ts
// 2026-09-30 v2.5.42 竹内「ITANDI 検索ちゃんとできていなければ、そこ修正するか、修正効かなければ拡張ツールの部分が問題なのか ITANDI への登録がちゃんと入らなかったのかが
//   原因となるので、その点も併せて確認して、次改善できるように学習できる形が理想」「画面見るところで、前に共有した物件はダウンロードされないようになっているのか読み取って」
//   サーバーの点検（search-audit-check）: ITANDI_GUARD（原因 拡張側／ITANDI 側／判断つかず × 直った／直らない／入れ直していない）・
//   SENT_SELECTED（選んだ・ダウンロードした部屋 × 送付済み）・cut_by_rows（物件数の上限）・週のまとめ（itandiGuardWeekly）・見張りの1行（sentSelectedNotice）
//   読み戻しの形は本番の ITANDI の点検（2026-09-28 02:06・日本橋1.2丁目・1LDK・form {layouts:["_r_50_"], rent_max:"15"}）
// 実行: npx tsx app/lib/__tests__/itandi-guard-check.test.ts
import { runSearchAuditChecks, itandiGuardCause, sentSelectedOf, itandiGuardWeekly, causeTitle, type AuditInput, type AuditCheck } from "../search-audit-check";
import { sentSelectedNotice, detectScreenState, updateDaysFindings } from "../screen-watch";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ""}`); }
}
const now = Date.parse("2026-09-30T02:00:00Z");
const okFill = { search_clicked: true, form: { layouts: ["_r_50_"], rent_max: "15", rent_min: "", age: "", walk: "" }, area_path: "area", stations_ok: [], stations_missing: [], lines_missing: [], click_fails: [], reset_fail: "条件リセットのボタンが見つからない（前の所在地が残るおそれ）" };
const base: AuditInput = {
  site: "itandi", status: "finished", trigger: "web_brain", created_at: new Date(now - 10 * 60_000).toISOString(),
  customer_snapshot: { rent_max: 150000, floor_plan: "1LDK", desired_area: "日本橋1.2丁目", area_mode: "ward" } as never,
  intended: { rent_max: 150000, floor_plan: "1LDK", area_mode: "ward", ward_names: ["中央区"] } as never,
  filled: okFill as never,
  result: { pages: 1, read_rows: 40, sent_count: 0 },
};
const first = { reasons: ["layout_outside"], judged: 40, outside: { rent: 0, layout: 33, area: 0, any: 33 }, count: null, samples: ["W-STYLE新大阪Ⅱ 1301（1K）"] };

console.log("\n■ 原因の分け方（1回目の読み戻しで）");
{
  const site = itandiGuardCause({ ...base, result: { ...base.result, guard: { suspect: true, first, first_fill: okFill as never } } });
  t("読み戻しが入れようとした値どおり → ITANDI 側", site.cause === "site", site);
  const extFill = { ...okFill, click_fails: [{ what: "layout", text: "1LDK" }] };
  const ext = itandiGuardCause({ ...base, result: { ...base.result, guard: { suspect: true, first, first_fill: extFill as never } } });
  t("押せなかった部品がある → 拡張側（根拠に何が押せなかったか）", ext.cause === "ext" && /1LDK/.test(ext.evidence.join()), ext);
  const areaRow: AuditInput = { ...base, intended: { ...(base.intended as object), unknown_tokens: ["日本橋1.2丁目"], ward_names: [] } as never, result: { ...base.result, guard: { suspect: true, first, first_fill: okFill as never } } };
  const ext2 = itandiGuardCause(areaRow);
  t("場所に直せなかった語がある（AREA_UNRESOLVED）→ 拡張側（本番 9/28 02:06 の形）", ext2.cause === "ext", ext2);
  const unk = itandiGuardCause({ ...base, filled: null, result: { ...base.result, guard: { suspect: true, first } } });
  t("読み戻しが無い → 判断つかず", unk.cause === "unknown");
  t("「条件リセットのボタンが見つからない」だけでは拡張側にしない（ITANDI は全回に付く）", site.cause === "site");
  t("読み戻しは1回目の物（first_fill）を使う（入れ直し後の filled が正しくても）", itandiGuardCause({ ...base, filled: okFill as never, result: { ...base.result, guard: { suspect: true, first, first_fill: extFill as never } } }).cause === "ext");
}

console.log("\n■ 点検の札 ITANDI_GUARD（原因 × 直った／直らない／入れ直していない）");
{
  const fixed = runSearchAuditChecks({ ...base, result: { ...base.result, sent_count: 12, guard: { suspect: true, reasons: ["layout_outside"], first, first_fill: okFill as never, retry: { tried: true, fixed: true, reasons: [], gap_ms: 12000 } } } }, now);
  const gf = fixed.checks.find((c) => c.code === "ITANDI_GUARD");
  t("入れ直しで直った → warn・鍵 itandi_guard:itandi:site:fixed", !!gf && gf.severity === "warn" && gf.cause_key === "itandi_guard:itandi:site:fixed" && /入れ直しで直った/.test(gf.title), gf);
  const unfixed = runSearchAuditChecks({ ...base, result: { ...base.result, guard_stopped: true, guard: { suspect: true, reasons: ["layout_outside"], first, first_fill: { ...okFill, click_fails: [{ what: "layout", text: "1LDK" }] } as never, retry: { tried: true, fixed: false, reasons: ["layout_outside"] } } } }, now);
  const gu = unfixed.checks.find((c) => c.code === "ITANDI_GUARD");
  t("直らず見送り → bad・鍵 itandi_guard:itandi:ext:unfixed・一番重い札", !!gu && gu.severity === "bad" && gu.cause_key === "itandi_guard:itandi:ext:unfixed" && unfixed.cause_key === "itandi_guard:itandi:ext:unfixed", gu);
  t("根拠に理由と行の数", !!gu && /希望に無い間取りが多い/.test(gu.detail) && /行 40のうち外 33/.test(gu.detail), gu?.detail);
  const noRetry = runSearchAuditChecks({ ...base, result: { ...base.result, guard_stopped: true, guard: { suspect: true, reasons: ["count_over"], first: { ...first, reasons: ["count_over"], count: 3200 } } } }, now);
  t("入れ直していない（古い版・時間切れ）→ no_retry", noRetry.checks.some((c) => c.cause_key === "itandi_guard:itandi:site:no_retry" && /件数 3200/.test(c.detail)), noRetry.checks);
  t("見分けが止めていない回には札を付けない", !runSearchAuditChecks(base, now).checks.some((c) => c.code === "ITANDI_GUARD"));
  t("原因の鍵 → 見出し", /itandi: 条件が効いていない検索（拡張側・直らず見送り）/.test(causeTitle("itandi_guard:itandi:ext:unfixed")) && /ITANDI 側・入れ直しで直った/.test(causeTitle("itandi_guard:itandi:site:fixed")));
  t("読んだ行がある（40行・資料は取っていない）ので 0件の札にしない", !unfixed.checks.some((c) => c.code.startsWith("ZERO_")));
}

console.log("\n■ 物件数の上限（cut_by_rows）→ 見張りの ⚠ の1行");
{
  const v = runSearchAuditChecks({ ...base, intended: { ...(base.intended as object), rp_update_days: 3 } as never, result: { pages: 2, read_rows: 50, sent_count: 50, row_limit: 50 } }, now);
  const c = v.checks.find((x) => x.cause_key === "update_days:itandi:cut_by_rows");
  t("row_limit → UPDATE_DAYS warn cut_by_rows", !!c && c.severity === "warn" && /上限（50件）で打ち切った/.test(c.title), v.checks);
  const f = updateDaysFindings({ checkpoint: "done", site: "itandi", dom: null, dom_error: null, checks: v.checks as never, error: null, error_kind: null, stall_kind: null, idle_min: null, waiting_for: null, range: null, read_rows: 50, decision: null, is_wide: false, area_size: null, update: null } as never);
  t("見張り: ★物件出し★のまとめの1行（残りのページの新着を見ていない）", f.items.some((x) => x.code === "cut_by_rows") && /上限（50件）で打ち切った/.test(f.notice ?? ""), f);
}

console.log("\n■ 送付済みの部屋を選んだ・ダウンロードした（SENT_SELECTED）");
{
  const sent = [{ name: "プレサンス難波インフィニティ", room: "304" }, { name: "エスリード難波ザ・アーク", room: "1104" }];
  const withPick: AuditInput = { ...base, site: "realpro", sent_rooms: sent, result: { pages: 1, read_rows: 20, sent_count: 18, sent_skipped: 2, picked_rooms: [{ n: "プレサンス難波インフィニティ", r: "0304" }, { n: "プレサンス難波インフィニティ", r: "305" }, { n: "新しい物件", r: "101" }] }, downloaded_rooms: [{ name: "エスリード難波ザ・アーク", room: "1104" }, { name: "新しい物件", room: "101" }] };
  const sel = sentSelectedOf(withPick);
  t("選んだ 0304（=304）と ダウンロードした 1104 の2部屋（305 は別の部屋）", !!sel && sel.count === 2 && sel.picked === 1 && sel.downloaded === 1, sel);
  const v = runSearchAuditChecks(withPick, now);
  const c = v.checks.find((x) => x.code === "SENT_SELECTED");
  t("札 SENT_SELECTED warn・鍵 sent_selected:realpro・見出しに数", !!c && c.severity === "warn" && c.cause_key === "sent_selected:realpro" && /送付済みの部屋を2件選んだ・ダウンロードした/.test(c.title), c);
  t("見張りの1行「⚠ 送付済みの部屋を2件ダウンロードしていた」", /⚠ 送付済みの部屋を2件ダウンロードしていた/.test(sentSelectedNotice(v.checks) ?? ""), sentSelectedNotice(v.checks));
  const det = detectScreenState({ checkpoint: "done", site: "realpro", dom: null, dom_error: null, checks: v.checks as never, error: null, error_kind: null, stall_kind: null, idle_min: null, waiting_for: null, range: null, read_rows: 20, decision: null, is_wide: false, area_size: null, update: null } as never);
  t("見張り: ラベルは normal のまま（検索は止めない）・規則に sent:selected・sent_notice", det.label === "normal" && det.rules.includes("sent:selected") && !!det.sent_notice, det);
  const clean = runSearchAuditChecks({ ...withPick, result: { pages: 1, read_rows: 20, sent_count: 20, sent_skipped: 3, picked_rooms: [{ n: "新しい物件", r: "101" }] }, downloaded_rooms: [{ name: "新しい物件", room: "101" }] }, now);
  const okc = clean.checks.find((x) => x.code === "SENT_SELECTED");
  t("送付済みを選んでいなければ ok の札（飛ばした 3件・数えない）", !!okc && okc.severity === "ok" && /3件は選ばなかった/.test(okc.title) && sentSelectedNotice(clean.checks) === null, okc);
  t("送付済みの一覧が無い（読めない）時は何も言わない", sentSelectedOf({ ...withPick, sent_rooms: null }) === null && !runSearchAuditChecks({ ...withPick, sent_rooms: [] }, now).checks.some((x) => x.code === "SENT_SELECTED"));
  t("号室が読めない行・「物件」は照らさない", sentSelectedOf({ sent_rooms: sent, result: { picked_rooms: [{ n: "プレサンス難波インフィニティ", r: null }, { n: "物件", r: "304" }] }, downloaded_rooms: [] })?.count === 0);
}

console.log("\n■ 週のまとめ（原因 × 直った／直らない・送付済み・上限）");
{
  const mk = (checks: Partial<AuditCheck>[]) => ({ checks: checks as AuditCheck[] });
  const rows = [
    mk([{ code: "ITANDI_GUARD", severity: "warn", cause_key: "itandi_guard:itandi:site:fixed", title: "", detail: "" }]),
    mk([{ code: "ITANDI_GUARD", severity: "bad", cause_key: "itandi_guard:itandi:ext:unfixed", title: "", detail: "" }]),
    mk([{ code: "ITANDI_GUARD", severity: "bad", cause_key: "itandi_guard:itandi:ext:fixed", title: "", detail: "" }]),
    mk([{ code: "ITANDI_GUARD", severity: "bad", cause_key: "itandi_guard:itandi:unknown:no_retry", title: "", detail: "" }]),
    mk([{ code: "SENT_SELECTED", severity: "warn", cause_key: "sent_selected:realpro", title: "送付済みの部屋を2件選んだ・ダウンロードした", detail: "" }, { code: "UPDATE_DAYS", severity: "warn", cause_key: "update_days:itandi:cut_by_rows", title: "", detail: "" }]),
    mk([{ code: "UPDATE_DAYS", severity: "warn", cause_key: "update_days:realpro:cut_by_pages", title: "", detail: "" }]),
  ];
  const w = itandiGuardWeekly(rows);
  t("原因×結果の数", w.guard.site.fixed === 1 && w.guard.ext.unfixed === 1 && w.guard.ext.fixed === 1 && w.guard.unknown.no_retry === 1 && w.guardRuns === 4, w.guard);
  t("入れ直しで直った率（試した3回のうち2回）", w.fixRate === 0.67, w.fixRate);
  t("送付済みを選んだ回と部屋数・上限で打ち切った回", w.sentSelectedRuns === 1 && w.sentSelectedRooms === 2 && w.rowCutRuns === 1 && w.pageCutRuns === 1);
  t("まとめの行（DeepSeek の材料・記録）", w.lines.length === 3 && /拡張側 2回（直った 1・直らず 1）/.test(w.lines[0]) && /入れ直しで直った率 67%/.test(w.lines[0]), w.lines);
  t("何も無ければ行も無い", itandiGuardWeekly([]).lines.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
