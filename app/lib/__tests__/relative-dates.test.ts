// 2026-10-23 日付の距離（relative-dates.ts）。今日は 2026-10-23(金) 15:00 JST に固定
// 実行: npx tsx app/lib/__tests__/relative-dates.test.ts
import { jstDayDiff, pastLabel, futureLabel, deadlineLabel, promiseDueYmdMs, buildRelativeDatesNote, relativeDatesBrainNoteFor, relativeDatesWriterNote, withRelativeDatesRule, RELATIVE_DATES_RULE, normalizeViewings } from "../relative-dates";
import type { LedgerEntry } from "../action-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 600))} to contain ${JSON.stringify(sub)}`); }
function not(s: string, sub: string) { if (s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 600))} not to contain ${JSON.stringify(sub)}`); }

const NOW = Date.parse("2026-10-23T15:00:00+09:00");
const ON = { BRAIN_RELATIVE_DATES: "on" };
const OFF = {};
const iso = (s: string) => new Date(Date.parse(s)).toISOString();
const entry = (kind: LedgerEntry["kind"], at: string, detail: LedgerEntry["detail"] = {}, status: LedgerEntry["status"] = "done"): LedgerEntry =>
  ({ kind, status, at: iso(at), source: "aix_log", confidence: 3, evidence: "", detail });

console.log("距離の札");
it("日の差は日本時間の暦（23:59 と翌 0:01 は1日違い）", () => {
  eq(jstDayDiff("2026-10-22T23:59:00+09:00", NOW), -1);
  eq(jstDayDiff("2026-10-23T00:01:00+09:00", NOW), 0);
  eq(jstDayDiff("2026-10-25", NOW), 2);
});
it("過去・先・期限の言い方", () => {
  eq([pastLabel(0), pastLabel(-1), pastLabel(-3)], ["今日", "昨日", "3日前"]);
  eq([futureLabel(0), futureLabel(1), futureLabel(2), futureLabel(5)], ["今日", "明日", "明後日", "5日後"]);
  eq([deadlineLabel(2), deadlineLabel(0), deadlineLabel(-1)], ["期限まで2日", "期限は今日", "期限を1日過ぎ"]);
});
it("約束の期限: 本日中＝送った日・明日＝翌日", () => {
  eq(jstDayDiff(promiseDueYmdMs("本日中にお送りさせて頂きます", iso("2026-10-21T10:00:00+09:00"))!, NOW), -2);
  eq(jstDayDiff(promiseDueYmdMs("明日管理会社に確認させて頂きます", iso("2026-10-23T10:00:00+09:00"))!, NOW), 1);
  eq(promiseDueYmdMs("確認出来次第ご連絡させて頂きます", iso("2026-10-23T10:00:00+09:00")), null);
});

console.log("ブレインの材料");
it("off の時は空・静的な前置きも同じ文字列", () => {
  eq(relativeDatesBrainNoteFor({ ledgerEntries: [entry("properties_sent", "2026-10-20T12:00:00+09:00")], sentProps: [], openPromises: [], lastCustomerAt: null }, NOW, OFF), "");
  eq(withRelativeDatesRule("X", OFF), "X");
  eq(withRelativeDatesRule("X", ON), "X" + RELATIVE_DATES_RULE);
});
it("送った物件は日ごとに・3日前は印なし・10日前は空き確認の印", () => {
  const s = buildRelativeDatesNote({ sentProps: [
    { property_name: "A荘", room_no: "101", sent_at: iso("2026-10-20T12:00:00+09:00") },
    { property_name: "B館", room_no: "202", sent_at: iso("2026-10-20T12:05:00+09:00") },
    { property_name: "C邸", room_no: "3", sent_at: iso("2026-10-13T12:00:00+09:00") },
    { property_name: "D共有", room_no: "", sent_at: iso("2026-10-23T09:00:00+09:00"), shared_only: true },
  ] }, NOW, ON);
  has(s, "【日付の距離（今日 10/23(金)");
  has(s, "・物件の送付 10/20(火)（3日前）: A荘 101・B館 202");
  has(s, "・物件の送付 10/13(火)（10日前）: C邸 3\n  ⚠ 7日以上前の資料");
  not(s, "D共有");
});
it("古い資料でもその後に確認していれば印を出さない", () => {
  const s = buildRelativeDatesNote({
    sentProps: [{ property_name: "C邸", room_no: "3", sent_at: iso("2026-10-13T12:00:00+09:00") }],
    ledgerEntries: [entry("confirmation_reported", "2026-10-21T12:00:00+09:00", { propertyNames: ["C邸"] })],
  }, NOW, ON);
  has(s, "（その後 10/21(水)（2日前） に募集状況を確認済み）");
  not(s, "⚠ 7日以上前の資料");
});
it("見積 8日前は条件が古い印・今日の見積は印なし", () => {
  const s = buildRelativeDatesNote({ ledgerEntries: [entry("estimate_sent", "2026-10-15T12:00:00+09:00", { estimateFor: ["A荘"] }), entry("estimate_sent", "2026-10-23T11:00:00+09:00", { estimateFor: ["B館"] })] }, NOW, ON);
  has(s, "・御見積書の送付 10/23(金)（今日）: B館");
  has(s, "・御見積書の送付 10/15(木)（8日前）: A荘\n  ⚠ 7日以上前の見積");
});
it("約束: 期限切れ・今日・期限の語なし3日以上", () => {
  const s = buildRelativeDatesNote({ openPromises: [
    { kind: "資料の送付", sentence: "本日中にお送りさせて頂きます", at: iso("2026-10-21T10:00:00+09:00") },
    { kind: "確認", sentence: "本日中に管理会社に確認させて頂きます", at: iso("2026-10-23T10:00:00+09:00") },
    { kind: "物件探し", sentence: "ピックアップ出来次第お送りさせて頂きます", at: iso("2026-10-19T10:00:00+09:00") },
  ] }, NOW, ON);
  has(s, "期限 10/21(水)（期限を2日過ぎ）\n  ⚠ 期限切れの約束");
  has(s, "（期限は今日）\n  ⚠ 期限は今日");
  has(s, "10/19(月)（4日前）「ピックアップ出来次第お送りさせて頂きます」（期限の語なし）\n  ⚠ 3日以上たった約束");
});
it("内覧: 明後日・済んだかの記録なし・取り消しは出さない", () => {
  const s = buildRelativeDatesNote({ viewings: normalizeViewings(null, [
    { viewing_date: "2026-10-25", viewing_time: "14:00:00", status: "scheduled", property_name: "A荘" },
    { viewing_date: "2026-10-21", viewing_time: null, status: "lapsed", property_name: "B館" },
    { viewing_date: "2026-10-24", viewing_time: null, status: "cancelled", property_name: "X" },
  ]) }, NOW, ON);
  has(s, "・内覧 10/25(日) 14:00（明後日）: A荘");
  has(s, "・内覧 10/21(水)（2日前・済んだかの記録なし）: B館");
  not(s, ": X");
});
it("お客様の最後の発言は昨日", () => has(buildRelativeDatesNote({ lastCustomerAt: iso("2026-10-22T20:00:00+09:00") }, NOW, ON), "・お客様の最後の発言 10/22(木)（昨日）"));
it("何も無ければ空", () => eq(buildRelativeDatesNote({}, NOW, ON), ""));

console.log("下書きの1ブロック");
it("今日の資料は「本日お送りした」・前の見積は「先日」", () => {
  const s = relativeDatesWriterNote([entry("properties_sent", "2026-10-23T09:00:00+09:00"), entry("estimate_sent", "2026-10-14T09:00:00+09:00")], NOW, ON);
  has(s, "- 物件の資料: 10/23(金)（今日） → 触れるなら「本日お送りした」");
  has(s, "- 御見積書: 10/14(水)（9日前） → 触れるなら「先日お送りした」の形（7日以上前");
  eq(relativeDatesWriterNote([entry("properties_sent", "2026-10-23T09:00:00+09:00")], NOW, OFF), "");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
