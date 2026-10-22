// 2026-10-20 竹内さんの新しいピッカー（審査について・申込状況について・バイク置き場・契約の条件・家賃の交渉・周辺の様子・物件について→募集号室について）のテスト。
//   LLM は呼ばない（純関数と切替 AIX_NEW_PICKERS_1020 の on/off だけ）
// 実行: npx tsx app/lib/__tests__/aix-new-pickers.test.ts
import {
  aixNewPickers1020Enabled, applicationStatusTextOk, composeApplicationStatusText, composeRoomVacanciesText,
  ensureScreeningSupportLine, isApplicationStatusQuestion, isRoomVacanciesQuestion, parseVacancyRows, SCREENING_SUPPORT_LINE,
  stripUncheckedScreeningClaims, aixRequestMustUseClaude,
} from "../aix-new-pickers";
import { willRouteAlt } from "../llm-alt-provider";
import { readFileSync } from "node:fs";
import { checkPatternForConfirmTopic, confirmObjectOf, confirmTopicsForCheckPattern } from "../action-ledger";
import { promisesInStaffText } from "../promise-queue";
import { normalizeBrainCheckPattern } from "../brain-check-pattern";
import { detectPropertyCheckPattern } from "../aix-taxonomy";
import { catalogBlockForBrain } from "../aix-catalog";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
function withSwitch(v: "on" | "off" | undefined, fn: () => void) {
  const prev = process.env.AIX_NEW_PICKERS_1020;
  if (v) process.env.AIX_NEW_PICKERS_1020 = v; else delete process.env.AIX_NEW_PICKERS_1020;
  try { fn(); } finally { if (prev === undefined) delete process.env.AIX_NEW_PICKERS_1020; else process.env.AIX_NEW_PICKERS_1020 = prev; }
}

it("切替は既定 on（2026-10-22 試験 p12-np-on で悪化なし・off で止める）", () => {
  ok(aixNewPickers1020Enabled({}), "既定 on でない");
  ok(!aixNewPickers1020Enabled({ AIX_NEW_PICKERS_1020: "off" }), "off で止まらない");
});

it("申込状況: 問いの網（ほかの方の申込）とご本人の申込の進捗は分ける", () => {
  ok(isApplicationStatusQuestion("13階は何人待ちですか？"), "何人待ち");
  ok(isApplicationStatusQuestion("エスリードはまだ申し込み入ってないんですか？"), "申込入ってない");
  ok(!isApplicationStatusQuestion("無事1番手でお申込完了しているか確認させて頂きます"), "ご本人の申込");
});

it("申込状況: 決まった型の文（お手本 d08bc127 の順）と型の確かめ", () => {
  const t = composeApplicationStatusText({ hasApplication: "あり", ahead: 1, firstStatus: "審査中", roomLabel: "1302号室" });
  ok(t.startsWith("1302号室のお部屋現在1人審査中となります！") && t.includes("2番手でのお申込") && t.includes("繰り上がる") && t.includes("如何でしょうか"), t);
  ok(applicationStatusTextOk(t, { hasApplication: "あり", ahead: 1 }), "自分の型が通らない");
  ok(!applicationStatusTextOk(t.replace(/2番手/g, "3番手"), { hasApplication: "あり", ahead: 1 }), "番手の違いを見逃す");
  const none = composeApplicationStatusText({ hasApplication: "なし" });
  ok(/1番手/.test(none) && !/2番手/.test(none) && applicationStatusTextOk(none, { hasApplication: "なし" }), none);
  const noSecond = composeApplicationStatusText({ hasApplication: "あり", ahead: 1, noSecond: true });
  ok(/受け付けていない/.test(noSecond), noSecond);
  ok(applicationStatusTextOk(noSecond, { hasApplication: "あり", ahead: 1, noSecond: true }), "2番手なしの型が通らない");
  ok(!applicationStatusTextOk("2番手は受け付けていないのですが、2番手でのお申込となり繰り上がりを待ちます", { hasApplication: "あり", ahead: 1, noSecond: true }), "2番手なしで申込める様に書いた文を見逃す");
});

it("審査について（ご相談）: 入力なしの時は「管理会社に確認した」行を落とす", () => {
  const s = stripUncheckedScreeningClaims("田中さん\nお世話になっております！！\nハイツAの審査につきまして管理会社に確認させて頂きました！！\n保証会社のみで審査可能とのことでした！！\n無事に審査通過するまで全力でサポートさせて頂きます😊！！");
  ok(!/管理会社|保証会社|とのこと/.test(s) && s.includes("審査はかけてみることが出来ます") && s.includes("全力でサポート") && s.startsWith("田中さん"), s);
  const k = stripUncheckedScreeningClaims("夜職の方でもお気に召されたお部屋でしたら審査はかけてみることが出来ます😊！！");
  ok(k === "夜職の方でもお気に召されたお部屋でしたら審査はかけてみることが出来ます😊！！", k);
});

it("審査について（ご相談）: 締めの一文は必ず1回", () => {
  const a = ensureScreeningSupportLine("保証会社のみで審査可能とのことでした！！");
  ok(a.endsWith(SCREENING_SUPPORT_LINE), a);
  ok(ensureScreeningSupportLine(a) === a, "2回付く");
});

it("審査について（ご相談）は必ず Claude（DeepSeek に回さない・スイッチに関係なく）", () => {
  // property_check_result を DeepSeek に回す設定でも、審査の相談だけは「申込以降」と同じ扱い＝回らない
  const env = { LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", LLM_ALT_ACTIONS: "property_check_result" };
  ok(willRouteAlt("property_check_result", {}, env), "前提: property_check_result が回る設定になっていない");
  const must = aixRequestMustUseClaude({ action: "property_check_result", check_pattern: "mgmt_screening" });
  ok(must, "審査の相談が Claude 固定になっていない");
  ok(!willRouteAlt("property_check_result", { postApply: must }, env), "審査の相談が DeepSeek に回る");
  withSwitch(undefined, () => ok(aixRequestMustUseClaude({ action: "property_check_result", check_pattern: "mgmt_screening" }), "off で外れる"));
  ok(!aixRequestMustUseClaude({ action: "property_check_result", check_pattern: "mgmt_parking" }), "ほかのピッカーまで固定");
  ok(!aixRequestMustUseClaude({ action: "property_recommendation", check_pattern: "mgmt_screening" }), "別の action まで固定");
  // aix/action の歯止めが実際にこれを渡している（読むだけの確かめ）
  const route = readFileSync("app/api/aix/action/route.ts", "utf8");
  ok(/setupAltProviderGuards\([^\n]*aixRequestMustUseClaude\(body\)\)/.test(route), "aix/action が aixRequestMustUseClaude を歯止めに渡していない");
  ok(/if \(forceClaude\) \{\s*ctx\.postApply = true;/.test(route), "forceClaude で postApply を立てていない");
});

it("物件について→募集号室について: 入力の行のまま一覧（AI なし）", () => {
  ok(isRoomVacanciesQuestion("ここ何部屋空いてますか？"), "問い");
  const rows = parseVacancyRows("・302号室 1K 68,000円\n\n505号室 1LDK 92,000円");
  const t = composeRoomVacanciesText({ propertyName: "ハイツA", rows });
  ok(t.split("\n")[0] === "ハイツA現在2部屋募集中となります！！", t);
  ok(t.includes("・302号室 1K 68,000円") && t.includes("・505号室 1LDK 92,000円"), t);
});

it("切替 off: 約束の台帳・網は今まで通り（バイクは駐車場・申込状況の要件は無い）", () => {
  withSwitch("off", () => {
    ok(confirmObjectOf("バイク置き場があるか確認させて頂きます！！") === "駐車場", String(confirmObjectOf("バイク置き場があるか確認させて頂きます！！")));
    ok(checkPatternForConfirmTopic("申込状況") === null && checkPatternForConfirmTopic("家賃の交渉") === null, "off でも新しいピッカー");
    ok(normalizeBrainCheckPattern("mgmt_screening") === null, "off でもブレインの値");
    ok(detectPropertyCheckPattern("短期解約の違約金はありますか？")?.check_pattern !== "mgmt_contract_terms", "off でも網");
    ok(!catalogBlockForBrain(null, { includeAll: true, env: { AIX_NEW_PICKERS_1020: "off" } }).includes("mgmt_application_status"), "off でもカタログ");
  });
});

it("切替 on: 約束 → ピッカー（申込状況・バイク置き場・契約の条件・家賃の交渉・周辺の様子・ペット）", () => {
  withSwitch("on", () => {
    ok(confirmObjectOf("バイク置き場があるか確認させて頂きます！！") === "バイク置き場", "バイク");
    ok(checkPatternForConfirmTopic("バイク置き場") === "mgmt_parking", "バイク→駐車場について");
    ok(confirmTopicsForCheckPattern("mgmt_parking").includes("バイク置き場"), "駐車場について がバイクの約束を閉じない");
    const q = promisesInStaffText("随時1番手お申し込み者さんの審査状況確認させていただきます！！", "2026-10-20T10:00:00Z");
    ok(q.some((s) => s.checkPattern === "mgmt_application_status"), JSON.stringify(q));
    const own = promisesInStaffText("無事1番手でお申込完了しているか確認させて頂きます！！", "2026-10-20T10:00:00Z");
    ok(!own.some((s) => s.checkPattern === "mgmt_application_status"), "ご本人の申込の進捗が申込状況になる");
    const pet = promisesInStaffText("ペット飼育について管理会社に確認させて頂きます！！", "2026-10-20T10:00:00Z");
    ok(pet.some((s) => s.checkPattern === "mgmt_pet"), JSON.stringify(pet));
    const park = promisesInStaffText("駐車場の空き状況確認させて頂きます！！", "2026-10-20T10:00:00Z");
    ok(park.some((s) => s.checkPattern === "mgmt_parking"), JSON.stringify(park));
    ok(checkPatternForConfirmTopic("契約の条件") === "mgmt_contract_terms" && checkPatternForConfirmTopic("家賃の交渉") === "mgmt_rent_negotiation" && checkPatternForConfirmTopic("周辺の様子") === "mgmt_surroundings", "要件→ピッカー");
    ok(normalizeBrainCheckPattern("mgmt_screening") === "mgmt_screening" && normalizeBrainCheckPattern("room_vacancies") === "room_vacancies", "ブレインの値");
    ok(catalogBlockForBrain(null, { includeAll: true, env: { AIX_NEW_PICKERS_1020: "on" } }).includes("mgmt_application_status"), "カタログに出ない");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
