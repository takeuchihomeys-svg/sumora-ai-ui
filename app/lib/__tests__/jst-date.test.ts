// 2026-09-12 竹内方針D: 日本時間の日付・曜日（jst-date.ts）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/jst-date.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import * as fs from "fs";
import * as path from "path";
import {
  jstParts, jstYmd, jstMD, jstMDHm, jstDateLabel, jstYmdWeekday, jstDayStartMs, jstWeekMondayYmd,
  weekdayForMonthDay, weekdayTable, fixDateWeekdays,
} from "../jst-date";
import { weekdayFor } from "../typo-check";

// ── ミニハーネス ──
let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}
const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");
const T = (iso: string) => Date.parse(iso);

describe("UTC→JST の日付の境界（UTC 15:00〜23:59 は JST の翌日 0:00〜8:59）", () => {
  it("J1 UTC 14:59:59 は JST 当日 23:59／UTC 15:00 は JST 翌日 0:00", () => {
    expect(jstYmd(T("2026-09-11T14:59:59Z"))).toBe("2026-09-11");
    expect(jstYmd(T("2026-09-11T15:00:00Z"))).toBe("2026-09-12");
    expect(jstParts(T("2026-09-11T15:00:00Z"))).toEqual({ y: 2026, m: 9, d: 12, hour: 0, minute: 0, dow: 6 });
  });
  it("J2 UTC 23:59 は JST 翌日 8:59（M/D・M/D HH:mm・曜日ラベル）", () => {
    const t = T("2026-09-11T23:59:00Z");
    expect(jstMD(t)).toBe("9/12");
    expect(jstMDHm(t)).toBe("9/12 08:59");
    expect(jstDateLabel(t)).toBe("9月12日（土）");
    expect(jstYmdWeekday(t)).toBe("2026/9/12（土）");
  });
  it("J3 ISO 文字列も受け取る・不正値は空文字", () => {
    expect(jstMD("2026-09-11T16:00:00Z")).toBe("9/12");
    expect(jstMD(null)).toBe("");
    expect(jstMD("not a date")).toBe("");
  });
  it("J4 JST 当日 0:00 の UTC ms・JST 週（月曜始まり）", () => {
    expect(jstDayStartMs(T("2026-09-11T20:00:00Z"))).toBe(T("2026-09-11T15:00:00Z"));
    expect(jstWeekMondayYmd(T("2026-09-13T16:00:00Z"))).toBe("2026-09-14"); // JST 9/14(月) 01:00
    expect(jstWeekMondayYmd(T("2026-09-13T14:00:00Z"))).toBe("2026-09-07"); // JST 9/13(日) 23:00
  });
});

describe("曜日は日付を正として日本時間の暦で決める", () => {
  it("W1 2026/6/29＝月・7/23＝木・8/1＝土（2025年の暦＝日・水・金 と取り違えない）", () => {
    const now = T("2026-07-01T03:00:00Z");
    expect(weekdayForMonthDay(6, 29, now)).toBe("月");
    expect(weekdayForMonthDay(7, 23, now)).toBe("木");
    expect(weekdayForMonthDay(8, 1, now)).toBe("土");
  });
  it("W2 年跨ぎ（JST 1/1 0:30 に 12/31 を見る／12/28 に 1/5 を見る）", () => {
    const newYear = T("2026-12-31T15:30:00Z"); // JST 2027-01-01 00:30
    expect(jstYmd(newYear)).toBe("2027-01-01");
    expect(weekdayForMonthDay(12, 31, newYear)).toBe("木"); // 2026-12-31
    expect(weekdayForMonthDay(1, 5, T("2026-12-28T03:00:00Z"))).toBe("火"); // 2027-01-05
  });
  it("W3 うるう年の2月29日（2028年は火・うるう年が近くに無ければ null）", () => {
    expect(weekdayForMonthDay(2, 29, T("2028-02-10T03:00:00Z"))).toBe("火");
    expect(weekdayForMonthDay(2, 29, T("2026-02-10T03:00:00Z"))).toBe(null);
    expect(weekdayForMonthDay(2, 30, T("2026-02-10T03:00:00Z"))).toBe(null);
  });
  it("W4 UTC ではまだ前日の時間帯でも JST の暦（2026-09-11T20:00Z＝JST 9/12(土)）で曜日表を作る", () => {
    const table = weekdayTable(T("2026-09-11T20:00:00Z"), 14).split("・");
    expect(table.length).toBe(14);
    expect(table[0]).toBe("9/12（土）");
    expect(table[2]).toBe("9/14（月）");
    expect(table[13]).toBe("9/25（金）");
  });
  it("W5 曜日表は月末を跨いでも正しい（9/28(月)→10/1(木)）", () => {
    const table = weekdayTable(T("2026-09-28T03:00:00Z"), 5);
    expect(table).toBe("9/28（月）・9/29（火）・9/30（水）・10/1（木）・10/2（金）");
  });
  it("W6 typo-check の weekdayFor は同じ関数（再エクスポート）", () => {
    expect(weekdayFor === weekdayForMonthDay).toBe(true);
  });
});

describe("文中の「日付（曜）」の補正", () => {
  it("F1 replace: 曜日だけを直す（全角数字・曜日表記の揺れも）", () => {
    const now = T("2026-06-25T03:00:00Z");
    expect(fixDateWeekdays("6/29（日）と７月２３日(水曜日)でご案内可能です", now).text).toBe("6/29（月）と７月２３日(木曜日)でご案内可能です");
  });
  it("F2 strip: 食い違う曜日だけ外す（正しい曜日は残す）", () => {
    const now = T("2026-06-25T03:00:00Z");
    expect(fixDateWeekdays("6/29（日）・6/30（火）", now, "strip").text).toBe("6/29・6/30（火）");
  });
  it("F3 正しい曜日・日付として無効なものは変えない", () => {
    const now = T("2026-09-11T03:00:00Z");
    const r = fixDateWeekdays("9/11（金）と9月14日(月)・2/30（月）", now);
    expect(r.text).toBe("9/11（金）と9月14日(月)・2/30（月）");
    expect(r.applied.length).toBe(0);
  });
});

describe("置き換え先（同じ事実を1関数で）", () => {
  it("R1 generate-reply の dateNote に14日分の曜日表を渡している", () => {
    expect(src("api/generate-reply/route.ts").includes("weekdayTable(Date.now(), 14)")).toBe(true);
  });
  it("R2 brain-core の送付日ラベルは timeZone 抜けの toLocaleDateString を使わない（jstMD）", () => {
    const s = src("lib/brain-core.ts");
    expect(s.includes(`toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })`)).toBe(false);
    expect(s.includes("${jstMD(p.sent_at)}送付")).toBe(true);
  });
  it("R3 +9h した Date にローカル getter を使う書き方が残っていない（bg-async・daily-brief）", () => {
    expect(/jst\.getMonth\(\)|jst\.getDate\(\)|jst\.getHours\(\)/.test(src("api/generate-draft-bg-async/route.ts"))).toBe(false);
    expect(/new Date\(jstMs\)\.getDay\(\)/.test(src("api/cron/daily-brief/route.ts"))).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
