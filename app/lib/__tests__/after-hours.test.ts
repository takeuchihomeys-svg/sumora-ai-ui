// 2026-09-16 竹内（💜 さん事例）: 申込の情報を受け取った時の「はい😊！！」を書かない・営業時間外は「明日確認してご連絡」・カレンダーは明日の午前中
// 実行: npx tsx app/lib/__tests__/after-hours.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { isMgmtAfterHours, ensureAfterHoursApplyLine, stripLeadingBareAck, APPLY_INFO_SENT_RE, AFTER_HOURS_APPLY_LINE } from "../after-hours";
import { promiseStartAt, promiseEventRows } from "../promise-calendar";
import { classifyStaffTextFacts } from "../action-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

// 💜 さん: 19:15 にお客様が緊急連絡先を送付 → 19:20 にスタッフが返信
const GEN = "はい😊！！\nお母様のお名前お送り頂きありがとうございます！！\n頂きました緊急連絡先情報でお申込み進めさせて頂きます！！\n審査結果分かり次第ご連絡させて頂きますので、何卒よろしくお願い致します！！";
const CUST = "頼経麻衣子ヨリツネマイコ\n1985.9.9\n岡山県岡山市中区祇園66-11\n知らない\n08023693150\n母\n専業主婦";

it("管理会社の営業時間外は 18:00〜翌 9:00（JST）", () => {
  expect(isMgmtAfterHours("2026-09-16T10:20:00Z")).toBe(true);  // 19:20 JST
  expect(isMgmtAfterHours("2026-09-16T09:00:00Z")).toBe(true);  // 18:00 JST（管理会社は18時まで）
  expect(isMgmtAfterHours("2026-09-16T08:59:00Z")).toBe(false); // 17:59 JST
  expect(isMgmtAfterHours("2026-09-16T00:00:00Z")).toBe(false); // 9:00 JST ちょうど＝営業開始
  expect(isMgmtAfterHours("2026-09-15T23:59:00Z")).toBe(true);  // 8:59 JST
  expect(isMgmtAfterHours(null)).toBe(false);
});

it("💜: 申込の情報を受け取った返信の先頭の「はい😊！！」を落とす", () => {
  expect(APPLY_INFO_SENT_RE.test(CUST)).toBe(true);
  expect(stripLeadingBareAck(GEN)).toBe("お母様のお名前お送り頂きありがとうございます！！\n頂きました緊急連絡先情報でお申込み進めさせて頂きます！！\n審査結果分かり次第ご連絡させて頂きますので、何卒よろしくお願い致します！！");
});
it("「はい！！ご案内可能です」のように本題が同じ行にある時は触らない・1行だけの時も触らない", () => {
  expect(stripLeadingBareAck("はい！！ご案内可能です😊！！")).toBe("はい！！ご案内可能です😊！！");
  expect(stripLeadingBareAck("はい😊！！")).toBe("はい😊！！");
  expect(stripLeadingBareAck("かしこまりました！！\nお申込み進めさせて頂きます！！")).toBe("かしこまりました！！\nお申込み進めさせて頂きます！！");
});

it("💜: 営業時間外は「審査結果分かり次第」の締めを「明日〜確認出来次第ご連絡」に置き換える（何卒は残す）", () => {
  const out = ensureAfterHoursApplyLine(stripLeadingBareAck(GEN), true);
  expect(out).toBe([
    "お母様のお名前お送り頂きありがとうございます！！",
    "頂きました緊急連絡先情報でお申込み進めさせて頂きます！！",
    AFTER_HOURS_APPLY_LINE,
    "何卒よろしくお願い致します！！",
  ].join("\n"));
});
it("営業時間内は足さない・既に営業時間外の主旨があれば触らない", () => {
  expect(ensureAfterHoursApplyLine(GEN, false)).toBe(GEN);
  const already = "かしこまりました！！\n管理会社営業時間外となりますので、明日確認出来次第ご連絡させて頂きます！！";
  expect(ensureAfterHoursApplyLine(already, true)).toBe(already);
  const alreadyTomorrow = "かしこまりました！！\n明日お申込完了しているか確認しご連絡させて頂きます！！";
  expect(ensureAfterHoursApplyLine(alreadyTomorrow, true)).toBe(alreadyTomorrow);
});
it("置き換える締めが無い時は「何卒よろしくお願い致します」の前に入れる", () => {
  const t = "かしこまりました！！\nお申込み進めさせて頂きます！！\n何卒よろしくお願い致します！！";
  expect(ensureAfterHoursApplyLine(t, true)).toBe(`かしこまりました！！\nお申込み進めさせて頂きます！！\n${AFTER_HOURS_APPLY_LINE}\n何卒よろしくお願い致します！！`);
  const t2 = "かしこまりました！！\nお申込み進めさせて頂きます！！";
  expect(ensureAfterHoursApplyLine(t2, true)).toBe(`かしこまりました！！\nお申込み進めさせて頂きます！！\n${AFTER_HOURS_APPLY_LINE}`);
});

// ── カレンダー: 明日の約束は翌日の午前中 ─────────────────────────
it("💜: 「明日〜確認出来次第ご連絡」の約束は翌日の午前10時に置く（旧: 約束した 19:20 のまま）", () => {
  expect(promiseStartAt("2026-09-16T10:20:00Z", "管理会社営業時間外となりますので、明日無事1番手でお申込完了しているか確認出来次第ご連絡させて頂きます"))
    .toBe(new Date("2026-09-17T10:00:00+09:00").toISOString());
  // 今日のうちにやる約束は約束した時刻のまま
  expect(promiseStartAt("2026-09-16T01:27:00Z", "募集状況確認させて頂きます")).toBe("2026-09-16T01:27:00Z");
  // 「翌営業日」「朝イチ」も明日の約束
  expect(promiseStartAt("2026-09-16T10:20:00Z", "翌営業日に交渉させていただきます")).toBe(new Date("2026-09-17T10:00:00+09:00").toISOString());
});
it("💜: 実際の本文から作る行も翌日午前（要件は番手・AIX は物件確認した）", () => {
  const text = "お母様のお名前お送り頂きありがとうございます！！\n頂きました緊急連絡先情報でお申込み進めさせて頂きます！！\n管理会社営業時間外となりますので、明日無事1番手でお申込完了しているか確認出来次第ご連絡させて頂きます！！\n何卒よろしくお願い致します！！";
  const rows = promiseEventRows(classifyStaffTextFacts(text, "2026-09-16T10:20:00Z"), { customerName: "💜", conversationId: "c", sentAt: "2026-09-16T10:20:00Z" });
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("💜 番手の確認→ご連絡");
  expect(rows[0].start_at).toBe(new Date("2026-09-17T10:00:00+09:00").toISOString());
  expect(rows[0].notes).toContain("約束: 「管理会社営業時間外となりますので、明日無事1番手でお申込完了しているか確認出来次第ご連絡させて頂きます」");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
