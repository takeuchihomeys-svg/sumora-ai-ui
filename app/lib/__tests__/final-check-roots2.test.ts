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
