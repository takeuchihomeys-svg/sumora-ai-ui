// 2026-09-27 竹内「重い順から治す」②: お客様の「審査落ちた」にブレインが 物件確認した を選んだ（YUMA 9fa0bd64）
//   お客様の発言は YUMA の徹底テストと本番の実物（scripts/audit-screening-failed-switch.ts・名前は伏せた）。
// 実行: npx tsx app/lib/__tests__/screening-failed-switch.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { isOwnScreeningFailureTurn, resolveScreeningFailedSwitch } from "../screening-failed-switch";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const SWITCH = { aix: "property_send", decisionSource: "correction:screening_failed_switch" };

console.log("切り替える（物件確認した → 物件ピックアップ）");
it("YUMA 9fa0bd64「さっき審査落ちたって連絡きました…😢」", () => {
  eq(resolveScreeningFailedSwitch("property_check_result", { text: "さっき審査落ちたって連絡きました…😢" }), SWITCH);
});
it("本番 60547092「前の物件が審査落ちした為新たに物件を紹介してほしいです!!」（スタッフはピックアップの宣言）", () => {
  eq(resolveScreeningFailedSwitch("property_check_result", { text: "夜職でも審査通りそうな物件紹介して欲しいです😭\n前の物件が審査落ちした為新たに物件を紹介してほしいです!!" }), SWITCH);
});
it("本番 79f057b5「ジェイリース ナップ とかも審査落ちしています」（会社名は報告なので外さない）", () => {
  eq(resolveScreeningFailedSwitch("acknowledge_check", { text: "ジェイリース ナップ とかも審査落ちしています\n全保連は今の家で通っていますが、今の家も引き続き借りておくので\n重量オーバーになると思います。" }), SWITCH);
});
it("本番 2f352488「…物件で入居審査が通らなかったため、審査が不安です」（済んだ報告＋心配・スタッフは物件ピックアップ）", () => {
  eq(resolveScreeningFailedSwitch("property_check_result", { text: "また、「GM KOHAMA」という物件で入居審査が通らなかったため、審査が不安です。\nそのため、保証会社の審査や入居審査について比較的相談しやすく、保証人不要で申し込み可能な物件を優先してご紹介いただけると助かります。" }), SWITCH);
});

console.log("変えない");
it("ブレインが 物件確認した 以外（なし・物件ピックアップ・内覧へ）はそのまま", () => {
  for (const a of [null, "property_send", "viewing_invite", "estimate_sheet"]) eq(resolveScreeningFailedSwitch(a, { text: "さっき審査落ちたって連絡きました…😢" }), null);
});
it("本番 b72f202b: 審査ダメ＋SUUMO の URL＋「ここって今空きありますか？」（特定のお部屋の確認＝物件確認したが正しい）", () => {
  eq(resolveScreeningFailedSwitch("property_check_result", { text: "数日前に相談させてもらった件ですが、審査ダメだったみたいなので\n物件お願いしたいです\nここって今空きありますか？\nle vida quo南堀江 6階 https://suumo.jp/x by SUUMO" }), null);
});
it("本番 be73fa13「同じエポスだと審査落ちてしまってるので無理ですよね？(涙)」（質問＝ブレインに任せる）", () => {
  eq(resolveScreeningFailedSwitch("property_check_result", { text: "ありがとうございます！\n同じエポスだと審査落ちてしまってるので無理ですよね？(涙)" }), null);
});
it("本番 3d9b67d7「他の保証会社とかありますか？…別の保証会社で審査お願いしたい」（同じお部屋で再審査）", () => {
  eq(resolveScreeningFailedSwitch("property_check_result", { text: "どうしてもあの物件が良く入居したいんですが、\n他の保証会社とかありますか？あれば再度\n別の保証会社で審査お願いしたいです。" }), null);
});
it("画像を持ち込んだ連投はそのまま", () => {
  eq(resolveScreeningFailedSwitch("property_check_result", { text: "審査落ちました", hasImage: true }), null);
});

console.log("isOwnScreeningFailureTurn（仮定・他人は報告ではない）");
it("仮定: 749c5559「こっちの審査落ちたら こっちに行きたいです」・79f057b5「審査がダメな場合もありますやね？」・9280fa49「もし審査が通らなかった時に」", () => {
  for (const t of ["こっちの審査落ちたら\nこっちに行きたいです", "審査がダメな場合もありますやね？", "僕の名義で申し込みして、もし審査が通らなかった時に代理契約でも可能であればそこで切り替えることも可能ですか？"]) eq([t, isOwnScreeningFailureTurn(t)], [t, false]);
});
it("仮定: 5752c0d1「今審査中の所落ちると日割り…」・3d9b67d7「審査落ちたってことですかね？」", () => {
  for (const t of ["ですよね\nとなれば今審査中の所落ちると日割り\n初期費用的にたかいですよね", "月曜日連絡なかったんですけど、審査落ちたってことですかね？"]) eq([t, isOwnScreeningFailureTurn(t)], [t, false]);
});
it("他人・番手: 「1番手の保証会社のところは審査通りませんでした」は番手の話として外す", () => {
  eq(isOwnScreeningFailureTurn("一度、違う不動産でそこも審査してもらってます。\n1番手の保証会社のところは審査通りませんでした。"), false);
});
it("否決の語が無い連投は false", () => {
  eq(isOwnScreeningFailureTurn("審査いつわかりますか？"), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
