// 2026-11-12 作業員20 最終チェックの残りの穴（TIME_INVALID の約束の相手・BANNED_WORD の資料免除・ルールの切り方）。各スイッチは既定 off
// 実行: npx tsx app/lib/__tests__/final-check-roots2.test.ts
import { sameDayPromiseBlocked, sentenceAtIndex, bannedWordMaterialGrounded, finalCheckRulesLimit } from "../final-check-roots2";
import { runDeterministicChecks, buildContextCheckPrompt } from "../final-check";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const withEnv = <T,>(e: Record<string, string>, fn: () => T): T => {
  const keep: Record<string, string | undefined> = {};
  for (const k of Object.keys(e)) { keep[k] = process.env[k]; process.env[k] = e[k]; }
  try { return fn(); } finally { for (const k of Object.keys(e)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
};

// ─── TIME_INVALID の約束の相手 ───
const SELF = "お部屋をピックアップして本日中にお送りさせて頂きます！！";
const MGMT = "募集状況を管理会社に本日中に確認してご連絡させて頂きます！！";
const ON_T = { FC_TIME_INVALID_TARGET: "on" };
it("時間 off: 18時以降は相手を問わず止める（今までどおり）", () => {
  eq(sameDayPromiseBlocked({ sentence: SELF, hour: 18, isWeekend: false, env: {} }), true);
  eq(sameDayPromiseBlocked({ sentence: MGMT, hour: 18, isWeekend: false, env: {} }), true);
});
it("時間 on: 自社の作業の約束は19時まで・管理会社に掛かる約束は18時で止める・土日は今までどおり", () => {
  eq(sameDayPromiseBlocked({ sentence: SELF, hour: 18, isWeekend: false, env: ON_T }), false);
  eq(sameDayPromiseBlocked({ sentence: SELF, hour: 19, isWeekend: false, env: ON_T }), true);
  eq(sameDayPromiseBlocked({ sentence: MGMT, hour: 18, isWeekend: false, env: ON_T }), true);
  eq(sameDayPromiseBlocked({ sentence: MGMT, hour: 17, isWeekend: false, env: ON_T }), false);
  eq(sameDayPromiseBlocked({ sentence: SELF, hour: 12, isWeekend: true, env: ON_T }), true);
});
it("時間: 実物の流れ（木曜18:30 JST の下書き）で TIME_INVALID_HONIJITSU が off では出て、on では自社作業だけ消える", () => {
  const now = Date.parse("2026-11-12T18:30:00+09:00");
  const ctx = { now, isAutoSend: true };
  const has = (t: string) => runDeterministicChecks(t, ctx).some((i) => i.code === "TIME_INVALID_HONIJITSU");
  eq(has(SELF), true); eq(has(MGMT), true);
  withEnv(ON_T, () => { eq(has(SELF), false, "自社作業"); eq(has(MGMT), true, "管理会社"); });
});
const ON_V = { FC_TIME_INVALID_TARGET: "on", FC_TIME_VACANCY_21: "on" };
it("時間（募集状況）: FC_TIME_VACANCY_21 off は今までどおり18時で止める", () => {
  eq(sameDayPromiseBlocked({ sentence: MGMT, hour: 19, isWeekend: false, env: ON_T }), true);
});
it("時間（募集状況）on: 募集状況・空室の確認は21時より前は止めない・21時以降は止める（5fe999f8）", () => {
  eq(sameDayPromiseBlocked({ sentence: MGMT, hour: 19, isWeekend: false, env: ON_V }), false);
  eq(sameDayPromiseBlocked({ sentence: MGMT, hour: 20, isWeekend: false, env: ON_V }), false);
  eq(sameDayPromiseBlocked({ sentence: MGMT, hour: 21, isWeekend: false, env: ON_V }), true);
  eq(sameDayPromiseBlocked({ sentence: "空室かどうか本日中に確認してご連絡いたします！！", hour: 19, isWeekend: false, env: ON_V }), false);
});
it("時間（募集状況）on: 木18:30「募集状況を確認してご連絡します」は止めず、21:10 で止める。募集中も同じ・番手・管理会社の入居可能日は18時の線", () => {
  const S = "募集状況を確認して本日中にご連絡します！！";
  eq(sameDayPromiseBlocked({ sentence: S, hour: 18, isWeekend: false, env: ON_V }), false);
  eq(sameDayPromiseBlocked({ sentence: S, hour: 21, isWeekend: false, env: ON_V }), true);
  eq(sameDayPromiseBlocked({ sentence: "まだ募集中か本日中に確認してご連絡します！！", hour: 20, isWeekend: false, env: ON_V }), false);
  eq(sameDayPromiseBlocked({ sentence: "番手の空きを管理会社に本日中に確認いたします！！", hour: 19, isWeekend: false, env: ON_V }), true);
  eq(sameDayPromiseBlocked({ sentence: "入居可能日を管理会社に本日中に確認いたします！！", hour: 19, isWeekend: false, env: ON_V }), true);
});
it("時間（募集状況）on: 設備・交渉・割引の確認は今までどおり18時で止める・土日も今までどおり", () => {
  eq(sameDayPromiseBlocked({ sentence: "ペット可かどうか管理会社に本日中に確認してご連絡いたします！！", hour: 19, isWeekend: false, env: ON_V }), true);
  eq(sameDayPromiseBlocked({ sentence: "礼金の交渉を管理会社に本日中にさせて頂きます！！", hour: 18, isWeekend: false, env: ON_V }), true);
  eq(sameDayPromiseBlocked({ sentence: "空室状況の確認を本日中にさせて頂きます！！", hour: 12, isWeekend: true, env: ON_V }), true);
});
it("時間（募集状況）on: 実物の流れ（木曜19:45 JST の下書き）で募集状況の約束は出ず、設備の約束は出る", () => {
  const ctx = { now: Date.parse("2026-11-12T19:45:00+09:00"), isAutoSend: true };
  const has = (t: string) => runDeterministicChecks(t, ctx).some((i) => i.code === "TIME_INVALID_HONIJITSU");
  withEnv(ON_V, () => { eq(has("募集状況を本日中に確認してご連絡させて頂きます！！"), false); eq(has("設備について管理会社に本日中に確認いたします！！"), true); });
});
it("sentenceAtIndex: 約束の文だけを取る", () => {
  const t = "ありがとうございます！！\n募集状況を管理会社に本日中に確認いたします！！\nよろしくお願いします";
  eq(sentenceAtIndex(t, t.indexOf("本日中に")), "募集状況を管理会社に本日中に確認いたします！！");
});

// ─── BANNED_WORD の資料免除 ───
const ON_B = { FC_BANNED_MATERIAL: "on" };
const T_REI = "礼金は家賃の2ヶ月分となっております😊！！";
const MAT = "礼金: 2ヶ月\n敷金: 1ヶ月\n仲介手数料: 0円";
it("資料 off: 「家賃の2ヶ月分」は資料があっても BANNED_WORD（今までどおり）", () => {
  eq(runDeterministicChecks(T_REI, { materialFacts: MAT }).some((i) => i.code === "BANNED_WORD"), true);
});
it("資料 on: 資料に同じ項目・同じ数（礼金 2ヶ月）があれば block しない・数が違えば今までどおり", () => {
  withEnv(ON_B, () => {
    eq(runDeterministicChecks(T_REI, { materialFacts: MAT }).some((i) => i.code === "BANNED_WORD"), false);
    eq(runDeterministicChecks(T_REI, { materialFacts: "礼金: 1ヶ月" }).some((i) => i.code === "BANNED_WORD"), true, "数が違う");
    eq(runDeterministicChecks(T_REI, {}).some((i) => i.code === "BANNED_WORD"), true, "資料なし");
    eq(runDeterministicChecks("初期費用は家賃の3ヶ月分です", { materialFacts: MAT }).some((i) => i.code === "BANNED_WORD"), true, "項目が無い言い切り");
    eq(runDeterministicChecks("少々お待ちください", { materialFacts: MAT }).some((i) => i.code === "BANNED_WORD"), true, "他の禁止語は不変");
  });
  eq(bannedWordMaterialGrounded("家賃の2ヶ月分", T_REI, MAT, {}), false);
});

// ─── ルールの切り方 ───
it("ルール off: context_check は2000字まで・on: 3000字まで届く", () => {
  const rules = "A".repeat(2400) + "【2400字目の禁止ルール】" + "B".repeat(200);
  const prompt = () => buildContextCheckPrompt("x", { finalCheckRules: rules }).map((b) => b.text).join("\n");
  eq(prompt().includes("2400字目の禁止ルール"), false);
  withEnv({ FC_RULES_SLICE_ALIGN: "on" }, () => { eq(prompt().includes("2400字目の禁止ルール"), true); eq(finalCheckRulesLimit(), 3000); });
  eq(finalCheckRulesLimit({}), 2000);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
