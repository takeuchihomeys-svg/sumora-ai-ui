// 2026-09-16 竹内（慶次・𝒮 さん事例）: 今日約束した事をカレンダーに【必ず】＋お客様名＋要件で置き、履行したら完了にする
// 実行: npx tsx app/lib/__tests__/promise-calendar.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { classifyStaffTextFacts } from "../action-ledger";
import { promiseEventRows, planPromiseInsert, planPromiseCompletion, isPromiseMustNotes, promiseHeadline, PROMISE_MUST_MARK } from "../promise-calendar";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

const KEIJI = "とんでもございません😊！！\n慶次さんにオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！\n保証会社の件も確認させて頂きますので、何卒よろしくお願い致します！！";
const KEIJI_AT = "2026-09-16T01:28:41Z"; // 9/16 10:28 JST
const S_TEXT = "お世話になっております！！\n\n改めて管理会社に11月中旬でのご入居が可能か交渉頂きます！！\n確認出来次第ご連絡させて頂きます😊！";

it("慶次: 1通の2つの約束が2行になる（お客様名＋要件・【必ず】・押す AIX）", () => {
  const rows = promiseEventRows(classifyStaffTextFacts(KEIJI, KEIJI_AT), { customerName: "慶次", conversationId: "c1", sentAt: KEIJI_AT });
  expect(rows.length).toBe(2);
  expect(rows[0].title).toBe("慶次 物件ピックアップ送付");
  expect(rows[0].event_type).toBe("property_send");
  expect(rows[0].notes.split("\n")[0]).toBe("【必ず】物件ピックアップ送付");
  expect(rows[0].notes).toContain("AIX: 【物件ピックアップした（または 物件オススメ）】を送ったら完了");
  expect(rows[1].title).toBe("慶次 保証会社の確認→ご連絡");
  expect(rows[1].event_type).toBe("follow_up");
  expect(rows[1].notes).toContain("約束: 「確認させて頂きます」");
  expect(rows[1].notes).toContain("（9/16 10:28 の送信から）");
  expect(rows[1].start_at).toBe(KEIJI_AT);
  expect(rows[1].customer_name).toBe("慶次");
});
it("𝒮: 管理会社の確認→ご連絡 が1行（お客様名付き）", () => {
  const rows = promiseEventRows(classifyStaffTextFacts(S_TEXT, "2026-09-16T01:27:11Z"), { customerName: "𝒮❦", conversationId: "c2", sentAt: "2026-09-16T01:27:11Z" });
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("𝒮❦ 管理会社の確認→ご連絡");
  expect(isPromiseMustNotes(rows[0].notes)).toBe(true);
});
it("実行した送信（物件送付・見積書送付）は行を作らない・お客様名が無ければ要件だけ", () => {
  const rows = promiseEventRows(classifyStaffTextFacts("🌟エストレーラ 305号室\nお手隙の際にご査収ください😌！！", null), { customerName: null, conversationId: "c3", sentAt: "2026-09-16T02:00:00Z" });
  expect(rows.length).toBe(0);
  const r2 = promiseEventRows(classifyStaffTextFacts("かしこまりました！！\n募集状況確認させて頂きます！！", null), { customerName: "", conversationId: "c3", sentAt: "2026-09-16T02:00:00Z" });
  expect(r2[0].title).toBe("募集状況の確認→ご連絡");
});
it("同じ要件の未完了の行があれば二重に作らない（送り直し・ブレインの再分析）", () => {
  const rows = promiseEventRows(classifyStaffTextFacts(KEIJI, KEIJI_AT), { customerName: "慶次", conversationId: "c1", sentAt: KEIJI_AT });
  const existing = [{ id: 1, notes: "【必ず】物件ピックアップ送付\n約束: 「…」", is_done: false }, { id: 2, notes: "[Brain AIX] action=property_send", is_done: false }];
  const ins = planPromiseInsert(rows, existing);
  expect(ins.length).toBe(1);
  expect(ins[0].title).toBe("慶次 保証会社の確認→ご連絡");
  // 完了済みの同じ要件は数えない（また約束したら新しい行）
  expect(planPromiseInsert(rows, [{ id: 1, notes: "【必ず】物件ピックアップ送付", is_done: true }]).length).toBe(2);
});
const OPEN = [
  { id: 1, event_type: "property_send", notes: "【必ず】物件ピックアップ送付", is_done: false },
  { id: 2, event_type: "follow_up", notes: "【必ず】保証会社の確認→ご連絡", is_done: false },
  { id: 3, event_type: "property_send", notes: "[Brain AIX] action=property_send", is_done: false },
  { id: 4, event_type: "viewing", notes: "【時間確保】\n候補: 9/16(水) 15:30〜17:00", is_done: false },
  { id: 5, event_type: "property_send", notes: "【必ず】物件ピックアップ送付", is_done: true },
  { id: 6, event_type: "follow_up", notes: "【必ず】募集状況の確認→ご連絡", is_done: false },
  { id: 7, event_type: "estimate_sheet", notes: "【必ず】御見積書送付", is_done: false },
];
const D = (kind: string, object: string | null = null) => ({ kind: kind as Parameters<typeof planPromiseCompletion>[0][number]["kind"], object });
it("履行した送信で完了にする行: 物件送付→ピックアップ＋募集状況の確認（保証会社の確認は残る）。[Brain AIX]・【時間確保】は触らない", () => {
  expect(planPromiseCompletion([D("properties_sent")], OPEN).sort().join(",")).toBe("1,6");
  expect(planPromiseCompletion([D("estimate_sent")], OPEN).sort().join(",")).toBe("6,7");
  expect(planPromiseCompletion([D("viewing_invited")], OPEN).length).toBe(0);
});
it("確認結果の報告: 対象があれば一致する確認の約束だけ・無ければ確認の約束を全部", () => {
  expect(planPromiseCompletion([D("confirmation_reported", "募集状況")], OPEN).join(",")).toBe("6");
  expect(planPromiseCompletion([D("confirmation_reported", "保証会社")], OPEN).join(",")).toBe("2");
  expect(planPromiseCompletion([D("confirmation_reported")], OPEN).sort().join(",")).toBe("2,6");
});
it("保証会社の案内（AIX 保証会社について）は保証会社の確認の約束だけ閉じる", () => {
  expect(planPromiseCompletion([D("guarantor_explained")], OPEN).join(",")).toBe("2");
});
it("見積書の約束は物件名付きの要件", () => {
  expect(promiseHeadline("estimate_declared", { estimateFor: ["エストレーラ 305号室"] })).toBe(`${PROMISE_MUST_MARK}御見積書送付（エストレーラ 305号室）`);
  expect(promiseHeadline("estimate_declared", {})).toBe(`${PROMISE_MUST_MARK}御見積書送付`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
