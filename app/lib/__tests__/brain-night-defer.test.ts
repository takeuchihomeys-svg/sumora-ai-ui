// 2026-09-24 竹内「22時〜9時のお客さんは分析せずに9時から分析するように仕組化したら他での浪費も防げるのでは？ 時間は日本時間に設定する」
//   夜の見送りの判定（純関数）の回帰テスト: 跨ぎ parser・JST の境界・until（次の 9:00）・origin・enabled・isOffSwitch
// 実行: npx tsx app/lib/__tests__/brain-night-defer.test.ts（自己完結ハーネス・env 不要。全 OK で exit 0）
import {
  parseHourRangeJst, inHourRangeJst, nightDeferUntilMs, decideNightDefer, decideNightDeferNow,
  isOffSwitch, isNightDeferEnabled, nightRangeFromEnv, BRAIN_NIGHT_FALLBACK, BRAIN_NIGHT_DEFAULT_HOURS, NIGHT_DEFER_ORIGINS,
  type BrainOrigin, type HourRangeJst,
} from "../brain-night-defer";
import { parseHoursJst } from "../reply-warm-prefix";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const T = (iso: string) => Date.parse(iso);
const NIGHT: HourRangeJst = { start: 22, end: 9, wraps: true };

console.log("── 跨ぎ parser（parseHourRangeJst）");
{
  t("undefined → fallback {22,9,wraps:true}", eq(parseHourRangeJst(undefined, BRAIN_NIGHT_FALLBACK), { start: 22, end: 9, wraps: true }));
  t("\"abc\" → fallback", eq(parseHourRangeJst("abc", BRAIN_NIGHT_FALLBACK), BRAIN_NIGHT_FALLBACK));
  t("\"22-22\"（start==end）→ fallback", eq(parseHourRangeJst("22-22", BRAIN_NIGHT_FALLBACK), BRAIN_NIGHT_FALLBACK));
  t("\"24-9\"（start 24）→ fallback", eq(parseHourRangeJst("24-9", BRAIN_NIGHT_FALLBACK), BRAIN_NIGHT_FALLBACK));
  t("\"23-8\" → wraps", eq(parseHourRangeJst("23-8", BRAIN_NIGHT_FALLBACK), { start: 23, end: 8, wraps: true }));
  t("\"0-6\" → 非跨ぎ", eq(parseHourRangeJst("0-6", BRAIN_NIGHT_FALLBACK), { start: 0, end: 6, wraps: false }));
  t("\"9-22\" → 非跨ぎ（night に渡せば字義どおり昼を夜扱い）", eq(parseHourRangeJst("9-22", BRAIN_NIGHT_FALLBACK), { start: 9, end: 22, wraps: false }));
  t("\"22-24\" → 非跨ぎ・end 24 を許す", eq(parseHourRangeJst("22-24", BRAIN_NIGHT_FALLBACK), { start: 22, end: 24, wraps: false }));
  t("\" 22 - 9 \"（空白）→ 読める", eq(parseHourRangeJst(" 22 - 9 ", BRAIN_NIGHT_FALLBACK), NIGHT));
  t("既定の文字列 BRAIN_NIGHT_DEFAULT_HOURS は fallback と同じ", eq(parseHourRangeJst(BRAIN_NIGHT_DEFAULT_HOURS, { start: 0, end: 1, wraps: false }), BRAIN_NIGHT_FALLBACK));
  // 回帰: 既存 parseHoursJst は "22-9" を今までどおり 7-24 に落とす（reply-warm-prefix.test.ts と同じ挙動。だから夜は新 parser）
  t("回帰: 既存 parseHoursJst(\"22-9\") は {7,24} のまま", eq(parseHoursJst("22-9"), { start: 7, end: 24 }));
}

console.log("── 境界（JST）: 22:00〜8:59 が夜");
{
  t("21:59 JST（12:59Z）→ 夜でない", inHourRangeJst(T("2026-09-24T12:59:00Z"), NIGHT) === false);
  t("22:00 JST（13:00Z）→ 夜", inHourRangeJst(T("2026-09-24T13:00:00Z"), NIGHT) === true);
  t("8:59 JST（前日 23:59Z）→ 夜", inHourRangeJst(T("2026-09-23T23:59:00Z"), NIGHT) === true);
  t("9:00 JST（00:00Z）→ 夜でない", inHourRangeJst(T("2026-09-24T00:00:00Z"), NIGHT) === false);
  t("0:00 JST（前日 15:00Z）→ 夜", inHourRangeJst(T("2026-09-23T15:00:00Z"), NIGHT) === true);
  t("12:00 JST（03:00Z）→ 昼", inHourRangeJst(T("2026-09-24T03:00:00Z"), NIGHT) === false);
  const day: HourRangeJst = { start: 9, end: 22, wraps: false };
  t("非跨ぎ 9-22: 9:00 JST は範囲内・22:00 JST は範囲外", inHourRangeJst(T("2026-09-24T00:00:00Z"), day) && !inHourRangeJst(T("2026-09-24T13:00:00Z"), day));
}

console.log("── until（次の end 時＝9:00 JST の UTC ms）");
{
  t("0:00 JST（9/24 15:00Z）→ 9/25 00:00Z（同じ JST 日の 9:00）", nightDeferUntilMs(T("2026-09-24T15:00:00Z"), NIGHT) === T("2026-09-25T00:00:00Z"));
  t("22:30 JST（9/24 13:30Z）→ 9/25 00:00Z（翌 JST 日）", nightDeferUntilMs(T("2026-09-24T13:30:00Z"), NIGHT) === T("2026-09-25T00:00:00Z"));
  t("UTC 日付跨ぎ: 9/24 23:30Z（=9/25 8:30 JST）→ 9/25 00:00Z", nightDeferUntilMs(T("2026-09-24T23:30:00Z"), NIGHT) === T("2026-09-25T00:00:00Z"));
  t("月末: 9/30 22:30 JST（9/30 13:30Z）→ 10/1 00:00Z", nightDeferUntilMs(T("2026-09-30T13:30:00Z"), NIGHT) === T("2026-10-01T00:00:00Z"));
  t("年末: 12/31 23:00 JST（12/31 14:00Z）→ 1/1 00:00Z", nightDeferUntilMs(T("2026-12-31T14:00:00Z"), NIGHT) === T("2027-01-01T00:00:00Z"));
  t("昼に呼ぶと翌日の 9:00（12:00 JST → 翌 00:00Z）", nightDeferUntilMs(T("2026-09-24T03:00:00Z"), NIGHT) === T("2026-09-25T00:00:00Z"));
  t("ちょうど 9:00 JST は「次」＝翌日（base <= now）", nightDeferUntilMs(T("2026-09-24T00:00:00Z"), NIGHT) === T("2026-09-25T00:00:00Z"));
}

console.log("── decideNightDefer（fail-open の順: disabled → origin → 時間帯）");
{
  const night = T("2026-09-24T16:00:00Z"); // 1:00 JST
  const day = T("2026-09-24T03:00:00Z");   // 12:00 JST
  const d = (origin: BrainOrigin | undefined, nowMs: number, enabled = true) => decideNightDefer({ nowMs, origin, enabled, range: NIGHT });
  t("enabled=false → defer:false reason disabled（夜でも）", eq(d("customer_message", night, false), { defer: false, until: null, reason: "disabled" }));
  t("origin staff は夜でも defer:false（origin:staff）", eq(d("staff", night), { defer: false, until: null, reason: "origin:staff" }));
  t("origin undefined は夜でも defer:false（origin:unknown・fail-open）", eq(d(undefined, night), { defer: false, until: null, reason: "origin:unknown" }));
  for (const o of ["customer_message", "image_read", "ui", "cron", "sweep"] as const) {
    const r = d(o, night);
    t(`${o} は夜なら defer:true・until 付き・reason に "22-9"`, r.defer && r.until === T("2026-09-25T00:00:00Z") && r.reason.includes("22-9"), r);
    t(`${o} は昼なら defer:false reason day`, eq(d(o, day), { defer: false, until: null, reason: "day" }));
  }
  t("昼は decideNightDefer の until が null（nightDeferUntilMs は翌 9:00 を返すが判定には載せない）", d("cron", day).until === null);
  t("NIGHT_DEFER_ORIGINS に staff は無い", !NIGHT_DEFER_ORIGINS.has("staff") && NIGHT_DEFER_ORIGINS.size === 5);
}

console.log("── isOffSwitch / env の読み方");
{
  t("\"off\" → true", isOffSwitch("off") === true);
  t("\" OFF \" → true", isOffSwitch(" OFF ") === true);
  t("\"on\" → false", isOffSwitch("on") === false);
  t("\"true\" → false", isOffSwitch("true") === false);
  t("\"1\" → false", isOffSwitch("1") === false);
  t("\"\" → false", isOffSwitch("") === false);
  t("undefined → false", isOffSwitch(undefined) === false);
  t("isNightDeferEnabled: 未設定は on・off で止まる", isNightDeferEnabled({}) === true && isNightDeferEnabled({ BRAIN_NIGHT_DEFER: "off" }) === false);
  t("nightRangeFromEnv: 未設定は 22-9・壊れた値も 22-9・\"23-8\" は読む",
    eq(nightRangeFromEnv({}), NIGHT) && eq(nightRangeFromEnv({ BRAIN_NIGHT_HOURS_JST: "x" }), NIGHT)
    && eq(nightRangeFromEnv({ BRAIN_NIGHT_HOURS_JST: "23-8" }), { start: 23, end: 8, wraps: true }));
  const night = T("2026-09-24T16:00:00Z");
  t("decideNightDeferNow: env を読んで判定（夜・customer_message → defer）", decideNightDeferNow("customer_message", night, {}).defer === true);
  t("decideNightDeferNow: BRAIN_NIGHT_DEFER=off → 走る", decideNightDeferNow("customer_message", night, { BRAIN_NIGHT_DEFER: "off" }).defer === false);
  t("decideNightDeferNow: BRAIN_NIGHT_HOURS_JST=\"2-3\" なら 1:00 JST は夜でない", decideNightDeferNow("customer_message", night, { BRAIN_NIGHT_HOURS_JST: "2-3" }).reason === "day");
}

console.log(`\n${passed} OK / ${failed} NG`);
if (failed > 0) process.exit(1);
