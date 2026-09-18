// 2026-09-16 竹内（慶次・𝒮 さん事例）: 今日約束した事をカレンダーに【必ず】＋お客様名＋要件で置き、履行したら完了にする
// 実行: npx tsx app/lib/__tests__/promise-calendar.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { classifyStaffTextFacts } from "../action-ledger";
import { promiseEventRows, planPromiseInsert, planPromiseCompletion, isPromiseMustNotes, promiseHeadline, promiseAixActionOf, PROMISE_MUST_MARK, oldestPromiseAtMs, promiseOverdueDays, comparePromiseFirst, sortMsOf } from "../promise-calendar";

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
  // 2026-09-16 竹内（Hina 事例）: 物件を送れば決まる約束は今日中のタスク → 頭に【今日中】
  expect(rows[0].title).toBe("【今日中】慶次 物件ピックアップ送付");
  expect(rows[0].event_type).toBe("property_send");
  expect(rows[0].notes.split("\n")[0]).toBe("【必ず】物件ピックアップ送付【今日中】");
  expect(rows[0].notes).toContain("AIX: 【物件ピックアップした（または 物件オススメ）】を送ったら完了");
  expect(rows[1].title).toBe("慶次 保証会社の確認→ご連絡");
  expect(rows[1].event_type).toBe("follow_up");
  // 約束の文がそのまま入る（旧: 正規表現の一致部分「確認させて頂きます」だけ）・保証会社は条件・交渉の AIX
  expect(rows[1].notes).toContain("約束: 「保証会社の件も確認させて頂きますので、何卒よろしくお願い致します」");
  expect(rows[1].notes).toContain("AIX: 【確認した（条件・交渉）→保証会社】を送ったら完了");
  expect(rows[1].notes).toContain("（9/16 10:28 の送信から）");
  expect(rows[1].start_at).toBe(KEIJI_AT);
  expect(rows[1].customer_name).toBe("慶次");
});
it("𝒮❦: 要件は「何を」（入居時期）・約束の文・条件交渉の AIX が入る（旧: 管理会社の確認→ご連絡／約束: 「確認出来次第」）", () => {
  const rows = promiseEventRows(classifyStaffTextFacts(S_TEXT, "2026-09-16T01:27:11Z"), { customerName: "𝒮❦", conversationId: "c2", sentAt: "2026-09-16T01:27:11Z" });
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("𝒮❦ 入居時期の確認→ご連絡");
  expect(rows[0].notes.split("\n")[0]).toBe("【必ず】入居時期の確認→ご連絡");
  expect(rows[0].notes).toContain("約束: 「改めて管理会社に11月中旬でのご入居が可能か交渉頂きます」");
  expect(rows[0].notes).toContain("AIX: 【確認した（条件・交渉）→入居時期】を送ったら完了");
  expect(isPromiseMustNotes(rows[0].notes)).toBe(true);
});
it("確認結果の報告文（〜とのご連絡がございました）は約束にしない・募集状況は従来どおり【物件確認した】", () => {
  const rep = classifyStaffTextFacts("お世話になっております！！\n管理会社に確認させていただき、受理とのご連絡がございました！！", null);
  expect(rep.some((e) => e.kind === "confirmation_promised")).toBe(false);
  expect(rep[0]?.kind).toBe("confirmation_reported");
  const r2 = promiseEventRows(classifyStaffTextFacts("かしこまりました！！\n募集状況確認させて頂きます！！", null), { customerName: "A", conversationId: "c", sentAt: "2026-09-16T02:00:00Z" });
  expect(r2[0].notes).toContain("AIX: 【物件確認した（確認結果を送る）】");
});
it("「新着でオススメできるお部屋で次第お送り」（打ち間違い）も外の出来事待ち＝行にしない", () => {
  const rows = promiseEventRows(classifyStaffTextFacts("かしこまりました！！\n新着でオススメできるお部屋で次第お送りさせて頂きます！！", null), { customerName: "隼斗", conversationId: "c", sentAt: "2026-09-16T02:00:00Z" });
  expect(rows.length).toBe(0);
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
// 2026-09-16 𝒮❦ 事例: 閉じ方は「何を」で照合する（相手の語は何にでも当たる・条件の確認は物件送付で閉じない）
const OPEN2 = [
  { id: 11, event_type: "follow_up", notes: "【必ず】入居時期の確認→ご連絡\n約束: 「…」", is_done: false },
  { id: 12, event_type: "follow_up", notes: "【必ず】管理会社の確認→ご連絡", is_done: false }, // 旧形式（中身不明）
  { id: 13, event_type: "estimate_sheet", notes: "【必ず】御見積書送付", is_done: false },
  { id: 14, event_type: "estimate_sheet", notes: "【必ず】御見積書送付（エストレーラ 305号室）", is_done: false },
];
const DC = (kind: string, object: string | null, checkPattern: string | null = null) => ({ kind: kind as Parameters<typeof planPromiseCompletion>[0][number]["kind"], object, checkPattern });
it("𝒮❦: AIX【確認した（条件・交渉）】入居時期（check_pattern）で入居時期の約束が閉じる。募集状況の報告では閉じない", () => {
  expect(planPromiseCompletion([DC("confirmation_reported", "審査", "mgmt_move_in")], OPEN2).sort().join(",")).toBe("11,12");
  expect(planPromiseCompletion([DC("confirmation_reported", "募集状況", "available")], OPEN2).join(",")).toBe("12");
});
it("手打ちの報告「オーナー様に確認したところ」（相手の語だけ）でも閉じる・「11月中旬のご入居で問題ない」でも閉じる", () => {
  expect(planPromiseCompletion([DC("confirmation_reported", "オーナー")], OPEN2).sort().join(",")).toBe("11,12");
  expect(planPromiseCompletion([DC("confirmation_reported", "入居時期")], OPEN2).sort().join(",")).toBe("11,12");
  expect(planPromiseCompletion([DC("confirmation_reported", "保証会社")], OPEN2).join(",")).toBe("12");
});
it("入居時期の確認は別の物件・御見積書を送っただけでは閉じない（中身不明の行は従来どおり閉じる）", () => {
  expect(planPromiseCompletion([DC("properties_sent", null)], OPEN2).join(",")).toBe("12");
  expect(planPromiseCompletion([DC("estimate_sent", null)], OPEN2).sort().join(",")).toBe("12,13,14");
});
it("募集終了・別のお部屋の報告で、物件名の無い御見積書の約束は閉じる（対象の部屋が無くなった）", () => {
  expect(planPromiseCompletion([DC("confirmation_reported", "募集状況", "unavailable")], OPEN2).sort().join(",")).toBe("12,13");
});
it("会話画面から開く AIX は行の種類で決まる", () => {
  expect(promiseAixActionOf("follow_up")).toBe("property_check_result");
  expect(promiseAixActionOf("property_send")).toBe("property_send");
  expect(promiseAixActionOf("estimate_sheet")).toBe("estimate_sheet");
  expect(promiseAixActionOf("viewing")).toBe(null);
});
it("見積書の約束は物件名付きの要件", () => {
  expect(promiseHeadline("estimate_declared", { estimateFor: ["エストレーラ 305号室"] })).toBe(`${PROMISE_MUST_MARK}御見積書送付（エストレーラ 305号室）`);
  expect(promiseHeadline("estimate_declared", {})).toBe(`${PROMISE_MUST_MARK}御見積書送付`);
});

// ── 2026-09-18 竹内「必ずのお客さんはLINEの上に上がるようにする。忘れないようにする為」──
const NOW = Date.parse("2026-09-18T12:00:00+09:00");
const d = (days: number) => ({ start_at: new Date(NOW - days * 86_400_000).toISOString() });

it("一覧: 約束のある会話が、直近やり取りが新しい会話より上に来る", () => {
  const withPromise = { promiseAt: oldestPromiseAtMs([d(1)]), updatedAtMs: sortMsOf("2026-09-15T10:00:00+09:00") };
  const newestNoPromise = { promiseAt: oldestPromiseAtMs([]), updatedAtMs: sortMsOf("2026-09-18T11:59:00+09:00") };
  expect(comparePromiseFirst(withPromise, newestNoPromise) < 0).toBe(true);
  expect(comparePromiseFirst(newestNoPromise, withPromise) > 0).toBe(true);
});

it("一覧: 約束のある会話どうしは、放置が長い（約束が古い）方が上", () => {
  const old3 = { promiseAt: oldestPromiseAtMs([d(3)]), updatedAtMs: sortMsOf("2026-09-18T11:00:00+09:00") };
  const new1 = { promiseAt: oldestPromiseAtMs([d(1)]), updatedAtMs: sortMsOf("2026-09-18T11:59:00+09:00") };
  expect(comparePromiseFirst(old3, new1) < 0).toBe(true);
});

it("一覧: 約束が複数ある会話は一番古い約束で並ぶ（新しい約束で上書きされない）", () => {
  expect(oldestPromiseAtMs([d(1), d(5), d(2)])).toBe(oldestPromiseAtMs([d(5)]));
});

it("一覧: 約束が無い会話どうしは従来どおり直近やり取り順", () => {
  const a = { promiseAt: null, updatedAtMs: sortMsOf("2026-09-18T11:00:00+09:00") };
  const b = { promiseAt: null, updatedAtMs: sortMsOf("2026-09-17T11:00:00+09:00") };
  expect(comparePromiseFirst(a, b) < 0).toBe(true);
});

it("バッジの日数は一番古い約束から（並びと同じ材料）", () => {
  expect(promiseOverdueDays([d(3), d(1)], NOW)).toBe(3);
  expect(promiseOverdueDays([d(0)], NOW)).toBe(0);
  expect(promiseOverdueDays([], NOW)).toBe(null);
  expect(promiseOverdueDays(undefined, NOW)).toBe(null);
});

it("読めない日付は並びを壊さない（NaN を混ぜない）", () => {
  expect(oldestPromiseAtMs([{ start_at: "" }, { start_at: "not-a-date" }])).toBe(null);
  expect(sortMsOf(null)).toBe(0);
  const broken = { promiseAt: null, updatedAtMs: sortMsOf(undefined) };
  const ok = { promiseAt: null, updatedAtMs: sortMsOf("2026-09-18T11:00:00+09:00") };
  expect(comparePromiseFirst(ok, broken) < 0).toBe(true);
});

it("実データの並び（9/15・9/17 の約束あり ＋ 新着だけの会話）", () => {
  const rows = [
    { id: "新着", promiseAt: oldestPromiseAtMs([]), updatedAtMs: sortMsOf("2026-09-18T11:59:00+09:00") },
    { id: "9/17約束", promiseAt: oldestPromiseAtMs([d(1)]), updatedAtMs: sortMsOf("2026-09-17T18:00:00+09:00") },
    { id: "9/15約束", promiseAt: oldestPromiseAtMs([d(3)]), updatedAtMs: sortMsOf("2026-09-15T10:52:00+09:00") },
    { id: "少し前", promiseAt: oldestPromiseAtMs([]), updatedAtMs: sortMsOf("2026-09-18T09:00:00+09:00") },
  ];
  expect([...rows].sort(comparePromiseFirst).map((r) => r.id).join(",")).toBe("9/15約束,9/17約束,新着,少し前");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
