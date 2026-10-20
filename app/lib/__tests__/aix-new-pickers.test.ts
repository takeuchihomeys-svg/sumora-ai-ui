// 2026-10-20 竹内さんの新しいピッカー（審査について・申込状況について・バイク置き場・契約の条件・家賃の交渉・周辺の様子・物件について→募集号室について）のテスト。
//   LLM は呼ばない（純関数と切替 AIX_NEW_PICKERS_1020 の on/off だけ）
// 実行: npx tsx app/lib/__tests__/aix-new-pickers.test.ts
import {
  aixNewPickers1020Enabled, applicationStatusTextOk, composeApplicationStatusText, composeRoomVacanciesText,
  ensureScreeningSupportLine, isApplicationStatusQuestion, isRoomVacanciesQuestion, parseVacancyRows, SCREENING_SUPPORT_LINE,
} from "../aix-new-pickers";
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
function withSwitch(v: "on" | undefined, fn: () => void) {
  const prev = process.env.AIX_NEW_PICKERS_1020;
  if (v) process.env.AIX_NEW_PICKERS_1020 = v; else delete process.env.AIX_NEW_PICKERS_1020;
  try { fn(); } finally { if (prev === undefined) delete process.env.AIX_NEW_PICKERS_1020; else process.env.AIX_NEW_PICKERS_1020 = prev; }
}

it("切替は既定 off（on の時だけ）", () => {
  ok(!aixNewPickers1020Enabled({}), "既定 on になっている");
  ok(aixNewPickers1020Enabled({ AIX_NEW_PICKERS_1020: "on" }), "on で動かない");
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
});

it("審査について（ご相談）: 締めの一文は必ず1回", () => {
  const a = ensureScreeningSupportLine("保証会社のみで審査可能とのことでした！！");
  ok(a.endsWith(SCREENING_SUPPORT_LINE), a);
  ok(ensureScreeningSupportLine(a) === a, "2回付く");
});

it("物件について→募集号室について: 入力の行のまま一覧（AI なし）", () => {
  ok(isRoomVacanciesQuestion("ここ何部屋空いてますか？"), "問い");
  const rows = parseVacancyRows("・302号室 1K 68,000円\n\n505号室 1LDK 92,000円");
  const t = composeRoomVacanciesText({ propertyName: "ハイツA", rows });
  ok(t.split("\n")[0] === "ハイツA現在2部屋募集中となります！！", t);
  ok(t.includes("・302号室 1K 68,000円") && t.includes("・505号室 1LDK 92,000円"), t);
});

it("切替 off: 約束の台帳・網は今まで通り（バイクは駐車場・申込状況の要件は無い）", () => {
  withSwitch(undefined, () => {
    ok(confirmObjectOf("バイク置き場があるか確認させて頂きます！！") === "駐車場", String(confirmObjectOf("バイク置き場があるか確認させて頂きます！！")));
    ok(checkPatternForConfirmTopic("申込状況") === null && checkPatternForConfirmTopic("家賃の交渉") === null, "off でも新しいピッカー");
    ok(normalizeBrainCheckPattern("mgmt_screening") === null, "off でもブレインの値");
    ok(detectPropertyCheckPattern("短期解約の違約金はありますか？")?.check_pattern !== "mgmt_contract_terms", "off でも網");
    ok(!catalogBlockForBrain(null, { includeAll: true, env: {} }).includes("mgmt_application_status"), "off でもカタログ");
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
