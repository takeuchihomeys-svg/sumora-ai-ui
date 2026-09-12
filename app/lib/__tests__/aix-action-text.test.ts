// 2026-09-12 竹内方針: 売上番長グループの「AIX要対応」— お客さん名と AIX ボタンの種類の指示・一覧（✅=完了）の文面
// 実行: npx tsx app/lib/__tests__/aix-action-text.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { aixButtonText, buildAixActionNotice, buildAixActionList, isFreshAixTurn, AIX_NOTICE_FRESH_MS, type AixActionItemRow } from "../aix-action-text";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected not to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}
// 2026-09-12 14:30 JST
const NOW = Date.UTC(2026, 8, 12, 5, 30);
const row = (o: Partial<AixActionItemRow>): AixActionItemRow => ({
  id: "x", conversation_id: "c", customer_name: "あ", action: "estimate_sheet", check_pattern: null,
  status: "pending", done_aix_type: null, done_at: null, created_at: "2026-09-12T01:00:00Z", ...o,
});

it("ボタン表記: 見積書送る", () => expect(aixButtonText("estimate_sheet")).toBe("AIX【見積書送る】"));
it("ボタン表記: 物件確認した（募集状況）", () => expect(aixButtonText("property_check_result")).toBe("AIX【物件確認した（募集状況）】"));
it("ボタン表記: 入居可能日の確認は「確認した（条件・交渉）→入居可能日」", () => {
  expect(aixButtonText("property_check_result", "mgmt_move_in")).toBe("AIX【確認した（条件・交渉）→入居可能日】");
});
it("1件通知: お客さん名と AIX ボタンの種類", () => {
  const t = buildAixActionNotice("じゅにあ", "viewing_invite");
  expect(t).toContain("【AIX要対応】"); expect(t).toContain("じゅにあさん → AIX【内覧日調整】");
});
it("一覧: 未対応は・、今日完了は✅、残り件数", () => {
  const t = buildAixActionList([
    row({ customer_name: "あ", action: "property_check_result" }),
    row({ customer_name: "SHIGI", status: "done", done_aix_type: "estimate_sheet", done_at: "2026-09-12T03:00:00Z" }),
  ], NOW)!;
  expect(t).toContain("【AIX要対応リスト】9/12 14:30");
  expect(t).toContain("・あさん → AIX【物件確認した（募集状況）】");
  expect(t).toContain("✅SHIGIさん → AIX【見積書送る】");
  expect(t).toContain("残り 1件");
});
it("一覧: 前日に完了したものは出さない（日本時間の0時で区切る）", () => {
  const t = buildAixActionList([
    row({ customer_name: "あ" }),
    row({ customer_name: "昨日", status: "done", done_at: "2026-09-11T14:59:00Z" }), // 9/11 23:59 JST
  ], NOW)!;
  expect(t).notToContain("昨日さん");
});
it("一覧: 全部完了なら🎉", () => {
  const t = buildAixActionList([row({ status: "done", done_aix_type: "estimate_sheet", done_at: "2026-09-12T04:00:00Z" })], NOW)!;
  expect(t).toContain("🎉 AIX要対応 全件完了！");
});
it("一覧: ブレインの指示と違う AIX を送った完了は、実際に送った AIX を表示", () => {
  const t = buildAixActionList([row({ customer_name: "c", action: "viewing_invite", status: "done", done_aix_type: "property_send", done_at: "2026-09-12T04:00:00Z" })], NOW)!;
  expect(t).toContain("✅cさん → AIX【物件ピックアップした】");
});
it("一覧: 対象が無ければ送らない（null）", () => expect(buildAixActionList([], NOW)).toBe(null));

// 2026-09-12 竹内（Sky・AKANE・まさゆき事例）: 何日も前のお客様発言を今分析しても「今の要対応」ではない
it("鮮度: Sky（9/1 の発言を 9/12 に分析）は要対応にしない", () => expect(isFreshAixTurn("2026-09-01T02:41:55.162+00:00", NOW)).toBe(false));
it("鮮度: AKANE（8/28 の発言）は要対応にしない", () => expect(isFreshAixTurn("2026-08-28T08:13:30.251+00:00", NOW)).toBe(false));
it("鮮度: まさゆき（9/4 の発言）は要対応にしない", () => expect(isFreshAixTurn("2026-09-04T03:43:56.084+00:00", NOW)).toBe(false));
it("鮮度: 数時間前の発言は要対応", () => expect(isFreshAixTurn("2026-09-12T02:44:53.36+00:00", NOW)).toBe(true));
it("鮮度: 夜の発言を翌日昼に返す（約12時間前）は要対応", () => expect(isFreshAixTurn("2026-09-11T17:46:41.291+00:00", NOW)).toBe(true));
it("鮮度: ちょうど48時間は要対応・48時間1分は外す", () => {
  expect(isFreshAixTurn(new Date(NOW - AIX_NOTICE_FRESH_MS).toISOString(), NOW)).toBe(true);
  expect(isFreshAixTurn(new Date(NOW - AIX_NOTICE_FRESH_MS - 60_000).toISOString(), NOW)).toBe(false);
});
it("鮮度: 時刻不明は判断できないので通す", () => {
  expect(isFreshAixTurn(null, NOW)).toBe(true);
  expect(isFreshAixTurn("not-a-date", NOW)).toBe(true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
