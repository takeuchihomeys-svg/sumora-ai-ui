// 2026-09-15 竹内（yasuki 事例）: お客様の「明日」を日本時間の暦で絶対の日に直し、今から見た言い方に書き換える
// 実行: npx tsx app/lib/__tests__/relative-date.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveRelativeDays, expressionForNow, buildRelativeDayNote, fixStaleRelativeDays, absolutizeRelativeDays, jstDayLabel } from "../relative-date";

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

// yasuki の実会話: お客様 9/15(月) 18:15 JST（＝09:15 UTC）／返信は 9/16(火) 8:37 JST（＝前日 23:37 UTC）
const CUST_AT = Date.parse("2026-09-15T09:15:51Z");
const NOW = Date.parse("2026-09-15T23:37:00Z");
const CUST = "確認したい事がありますのでまた明日午前中に連絡させて頂きます。";

it("yasuki: お客様の「明日」は 9/16（水）＝返信時点の今日", () => {
  const hits = resolveRelativeDays(CUST, CUST_AT);
  expect(hits.length).toBe(1);
  expect(jstDayLabel(hits[0].dayStartMs)).toBe("9/16（水）");
  expect(expressionForNow(hits[0].dayStartMs, NOW)).toBe("本日");
});
it("yasuki: 下書きの「明日午前中のご連絡お待ちしております」を「本日午前中」に直す", () => {
  const r = fixStaleRelativeDays("かしこまりました！！\n明日午前中のご連絡お待ちしております😊！！\n気になる点等ございましたらいつでもお気軽にご連絡ください！！", CUST, CUST_AT, NOW);
  expect(r.text).toBe("かしこまりました！！\n本日午前中のご連絡お待ちしております😊！！\n気になる点等ございましたらいつでもお気軽にご連絡ください！！");
  expect(r.applied.join(",")).toBe("STALE_RELATIVE_DAY_FIXED:明日→本日");
});
it("同じ日に返信する時は直さない（お客様の明日＝こちらから見ても明日）", () => {
  const sameDay = Date.parse("2026-09-15T10:00:00Z"); // 9/15 19:00 JST
  const r = fixStaleRelativeDays("かしこまりました！！\n明日午前中のご連絡お待ちしております😊！！", CUST, CUST_AT, sameDay);
  expect(r.applied.length).toBe(0);
  expect(buildRelativeDayNote(CUST, CUST_AT, sameDay)).toBe("");
});
it("こちらの新しい約束の「明日」は触らない（待つ文だけ直す）", () => {
  const r = fixStaleRelativeDays("かしこまりました！！\n明日一番で管理会社に確認しご連絡させて頂きます！！", CUST, CUST_AT, NOW);
  expect(r.text).toContain("明日一番で管理会社に確認し");
  expect(r.applied.length).toBe(0);
});
it("過ぎた日（2日後に返信）は日付の語を落とす", () => {
  const twoDaysLater = Date.parse("2026-09-17T01:00:00Z"); // 9/17 10:00 JST
  const r = fixStaleRelativeDays("かしこまりました！！\n明日午前中のご連絡お待ちしております😊！！", CUST, CUST_AT, twoDaysLater);
  expect(r.text).toBe("かしこまりました！！\nご連絡お待ちしております😊！！");
  expect(r.applied.join(",")).toBe("STALE_RELATIVE_DAY_DROPPED:明日");
});
it("生成の指示（今は9/16なので「本日」と書く）", () => {
  const note = buildRelativeDayNote(CUST, CUST_AT, NOW);
  expect(note).toContain("お客様の「明日」＝9/16（水）");
  expect(note).toContain("「本日」と書く");
});
it("明後日・一昨日も日本時間の暦で数える（語の重なりで壊れない）", () => {
  expect(jstDayLabel(resolveRelativeDays("明後日はどうでしょうか", CUST_AT)[0].dayStartMs)).toBe("9/17（木）");
  const h = resolveRelativeDays("一昨日お送りした物件です", CUST_AT);
  expect(h.length).toBe(1);
  expect(jstDayLabel(h[0].dayStartMs)).toBe("9/13（日）");
  expect(absolutizeRelativeDays("一昨日の物件", CUST_AT)).toBe("9/13（日）の物件");
});
it("ブレインの判断は絶対の日で残す（翌日に読まれても写されない）", () => {
  expect(absolutizeRelativeDays("明日午前の連絡を待つ姿勢を示し安心感を与える", CUST_AT)).toBe("9/16（水）午前の連絡を待つ姿勢を示し安心感を与える");
  expect(absolutizeRelativeDays("明日午前", CUST_AT)).toBe("9/16（水）午前");
  expect(absolutizeRelativeDays("10月中", CUST_AT)).toBe("10月中");
});
it("日本時間の日境（UTC の前日夜は JST の翌日）", () => {
  // 9/15 23:37 UTC = 9/16 8:37 JST → 今日は 9/16
  expect(jstDayLabel(resolveRelativeDays("本日よろしくお願いします", NOW)[0].dayStartMs)).toBe("9/16（水）");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
