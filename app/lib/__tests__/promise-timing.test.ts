// 2026-10-01 竹内（和樹事例）「『引き続き新着で…お送り』という約束は『新着が出たら送る』約束として扱う形、これはLINEみていてもそうなっている。
//   このように法則性見つけたらもっと質よくなる」
// 実行: npx tsx app/lib/__tests__/promise-timing.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 文は全部スタッフの実送信（scripts/audit-pickup-promise-timing.ts の出力）のまま
import { classifyStaffTextFacts } from "../action-ledger";
import { classifyPickupPromiseTiming, isWaitPromiseNotes, waitPromiseBadge } from "../promise-timing";
import { promiseEventRows, planPromiseCompletion, planPromiseInsert, promiseOverdueDays, splitPromisesForFreshInquiry } from "../promise-calendar";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}
const T = (s: string) => classifyPickupPromiseTiming(s).timing;

// ── 新着が出たら送る（期日なし） ──
it("和樹 9/30 11:08: 引き続き新着で…ピックアップしお送り → 新着待ち", () => {
  expect(T("引き続き新着でオススメできるお部屋ピックアップしお送りさせていただきます")).toBe("new_arrival");
});
it("引き続き＋新着の言い方違い（隼斗 9/28・ゆーすけ 7/4・reina 8/22）→ 新着待ち", () => {
  expect(T("引き続きオススメできるお部屋新着でピックアップさせていただきます")).toBe("new_arrival");
  expect(T("引き続き新着でゆーすけさんにオススメ出来るお部屋ピックアップさせていただきます")).toBe("new_arrival");
  expect(T("引き続き新着でreinaさんのご条件に合ったお部屋お探しさせて頂きます")).toBe("new_arrival");
});
it("次第・随時・出ましたら・日々確認 → 新着待ち（旧の外の出来事待ちと同じ線＋）", () => {
  expect(T("新着でオススメできるお部屋で次第お送りさせて頂きます")).toBe("new_arrival");
  expect(T("引き続きオススメできるお部屋新着で募集に出ましたら随時お送りさせていただきます")).toBe("new_arrival");
  expect(T("新着でオススメ出来るお部屋出ましたらお送りさせていただきます")).toBe("new_arrival");
  expect(T("新着物件出次第お送りさせて頂きます")).toBe("new_arrival");
  expect(T("新着物件を日々確認させて頂き、ゆうあさんにオススメ出来るお部屋お送りさせて頂きます")).toBe("new_arrival");
});
it("引き続き探す（ピックアップ・お送りの語なし）・サポートの宣言 → 新着待ち", () => {
  expect(T("引き続きオススメできるお部屋探しさせていただきます")).toBe("new_arrival");
  expect(T("引き続き審査通過しやすいお部屋探しさせていただきます")).toBe("new_arrival");
  expect(T("のあちさんのお部屋探しサポートさせていただきます")).toBe("new_arrival");
  expect(T("お部屋探しご担当させて頂きます鈴木と申します")).toBe("new_arrival");
});

// ── 今日中（従来どおり） ──
it("条件を言い直してのピックアップ（新たに・〜周辺全域から・〜万円以内）→ 今日中", () => {
  expect(T("家賃12万円のご条件で、堺筋本町駅・長堀橋駅・松屋町駅周辺から五嶋さんにオススメ出来るお部屋を新たにピックアップしてお送りさせて頂きます")).toBe("today");
  expect(T("エリア松原市まで広げてオススメできるお部屋もピックアップさせていただきます")).toBe("today");
  expect(T("西淀川区内から65,000まで・二人入居可・築浅・トイレと風呂別・独立洗面台・白い壁で、あかりさんにオススメできるお部屋をピックアップしてお送りさせて頂きます")).toBe("today");
});
it("引き続き＋ピックアップ（新着の語なし）は今日中のまま（9/30 H「引き続き審査通過しやすい保証会社採用したお部屋ピックアップ」は 0.1時間後に送付）", () => {
  expect(T("引き続き審査通過しやすい保証会社採用したお部屋ピックアップさせていただきます")).toBe("today");
  expect(T("引き続きオススメできるお部屋ピックアップさせていただきます")).toBe("today");
});
it("「新着で…ピックアップ」（引き続き・次第なし）・「新着物件併せて」は今日中（どちらとも言えない＝漏れない方）", () => {
  expect(T("新着で木下さんにオススメできるお部屋ピックアップさせていただきます")).toBe("today");
  expect(T("類似条件のお部屋でDaikiさんにオススメ出来る新着のお部屋合わせてピックアップしてお送りさせて頂きます")).toBe("today");
});
it("今日の語・ピックアップ出来次第（こちらの作業の次第）→ 今日中", () => {
  expect(T("本日中にSさんのご条件に合った物件ピックアップしピックアップ出来次第お送りさせて頂きます")).toBe("today");
  expect(T("慶次さんにオススメできるお部屋ピックアップ出来次第お送りさせて頂きます")).toBe("today");
});

// ── 日付・お客様待ち・時期待ち ──
it("明日 → 日付（𝑛𝑎 9/28 21:39）", () => {
  expect(T("明日カウンターキッチン付のお部屋ピックアップしお送りさせて頂きます")).toBe("date");
});
it("お客様が先（教えて頂ければ・お送り頂けましたら）→ お客様待ち", () => {
  expect(T("通勤先がどちらになるのか教えていただければ、宝塚周辺でピックアップさせて頂きます")).toBe("after_customer");
  expect(T("こちらお送り頂けましたら私の方で司さんにオススメできるお部屋ピックアップさせて頂きます")).toBe("after_customer");
});
it("時期が近づいたら → 時期待ち（aya 9/24）", () => {
  expect(T("お引越し時期近づいて参りましたらその際も全力でご満足いただけるお部屋探しサポートさせていただきます")).toBe("when_period");
});

// ── カレンダーの行（約束は消さない・印と見出しだけ） ──
const KAZUKI_AT = "2026-09-30T02:08:30Z";
const KAZUKI = "かしこまりました！！\n引き続き新着でオススメできるお部屋ピックアップしお送りさせていただきます！！";
it("和樹: 行は作る（消さない）・見出しは【必ず】新着が出たら物件送付【新着待ち】・【今日中】なし・約束した時に置く", () => {
  const rows = promiseEventRows(classifyStaffTextFacts(KAZUKI, KAZUKI_AT), { customerName: "和樹", conversationId: "c", sentAt: KAZUKI_AT });
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("和樹 新着が出たら物件送付");
  expect(rows[0].notes.split("\n")[0]).toBe("【必ず】新着が出たら物件送付【新着待ち】");
  expect(rows[0].event_type).toBe("property_send");
  expect(rows[0].start_at).toBe(KAZUKI_AT);
  expect(isWaitPromiseNotes(rows[0].notes)).toBe(true);
  expect(waitPromiseBadge(rows[0].notes)).toBe("新着が出たら送る");
});
it("明日の約束: 【今日中】を付けず翌日の午前に置く", () => {
  const rows = promiseEventRows(classifyStaffTextFacts("かしこまりました！！\n明日カウンターキッチン付のお部屋ピックアップしお送りさせて頂きます！！", "2026-09-28T12:39:00Z"), { customerName: "𝑛𝑎", conversationId: "c", sentAt: "2026-09-28T12:39:00Z" });
  expect(rows[0].title).toBe("𝑛𝑎 物件ピックアップ送付");
  expect(rows[0].notes.split("\n")[0]).toBe("【必ず】物件ピックアップ送付");
  expect(rows[0].start_at).toBe("2026-09-29T01:00:00.000Z");
});
it("今日の約束は従来どおり【今日中】", () => {
  const rows = promiseEventRows(classifyStaffTextFacts("承知致しました！！\nエリア松原市まで広げてオススメできるお部屋もピックアップさせていただきます！！", "2026-10-01T04:46:36Z"), { customerName: "a", conversationId: "c", sentAt: "2026-10-01T04:46:36Z" });
  expect(rows[0].title).toBe("【今日中】a 物件ピックアップ送付");
  expect(rows[0].notes.split("\n")[0]).toBe("【必ず】物件ピックアップ送付【今日中】");
});
it("新着待ちの行も物件を送ったら完了（同じ property_send）", () => {
  const open = [{ id: 951, event_type: "property_send", notes: "【必ず】新着が出たら物件送付【新着待ち】\n約束: 「…」", is_done: false }];
  expect(planPromiseCompletion([{ kind: "properties_sent" }], open).join(",")).toBe("951");
});
it("新着待ちの未完了がある時に同じ新着待ちを二重に作らない・今日の約束は別に作る", () => {
  const rows = promiseEventRows(classifyStaffTextFacts(KAZUKI, KAZUKI_AT), { customerName: "和樹", conversationId: "c", sentAt: KAZUKI_AT });
  const open = [{ id: 1, notes: "【必ず】新着が出たら物件送付【新着待ち】\n約束: 「…」", is_done: false }];
  expect(planPromiseInsert(rows, open).length).toBe(0);
  expect(planPromiseInsert(rows, [{ id: 2, notes: "【必ず】物件ピックアップ送付【今日中】", is_done: false }]).length).toBe(1);
});
it("一覧の「🔴必ず N日」は待ちの約束を数えない（今日の約束は数える）", () => {
  const NOW = Date.parse("2026-10-03T12:00:00+09:00");
  const wait = { start_at: "2026-09-30T02:08:30Z", notes: "【必ず】新着が出たら物件送付【新着待ち】" };
  const today = { start_at: "2026-10-02T02:00:00Z", notes: "【必ず】物件ピックアップ送付【今日中】" };
  expect(promiseOverdueDays([wait], NOW)).toBe(null);
  expect(promiseOverdueDays([wait, today], NOW)).toBe(1);
});
it("お客様の物件の確認が先（和樹 10/1）: 新着待ちの行も「後で」に回る（消さない）", () => {
  const r = splitPromisesForFreshInquiry([{ id: 951, event_type: "property_send", start_at: KAZUKI_AT, notes: "【必ず】新着が出たら物件送付【新着待ち】" }],
    { brainAction: "property_check_result", latestCustomerAt: "2026-10-01T03:45:00Z" });
  expect(r.later.length).toBe(1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
