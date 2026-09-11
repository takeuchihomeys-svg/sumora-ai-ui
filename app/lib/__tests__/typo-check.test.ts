// 2026-09-11 竹内方針1: 最終チェックの「誤字の確認」（typo-check.ts）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/typo-check.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import { detectTypos, applyTypoAutoFix, weekdayFor } from "../typo-check";
import { runDeterministicChecks, isRevisable } from "../final-check";

// ── ミニハーネス ──
let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}
const NOW = Date.parse("2026-09-11T03:00:00Z");
const fix = (s: string, name = "") => applyTypoAutoFix(s, { now: NOW, customerName: name }).text;

describe("検出して直す（実データで出現を確認した規則）", () => {
  it("T1 敬称の二重: さんさん → さん／お客様さん → お客様", () => {
    expect(fix("佐藤さんさんお世話になっております！！")).toBe("佐藤さんお世話になっております！！");
    expect(fix("お客様さんのご希望")).toBe("お客様のご希望");
  });
  it("T2 脱字: あがとう／かしこまりした／ありがとございます", () => {
    expect(fix("この度ご連絡頂きあがとうございます！！")).toBe("この度ご連絡頂きありがとうございます！！");
    expect(fix("かしこまりした！！")).toBe("かしこまりました！！");
    expect(fix("ありがとございます")).toBe("ありがとうございます");
  });
  it("T3 語の重複: ございますございます／お部屋お部屋／域から域から", () => {
    expect(fix("ありがとうございますございます！！")).toBe("ありがとうございます！！");
    expect(fix("オススメのお部屋お部屋ピックアップ")).toBe("オススメのお部屋ピックアップ");
    expect(fix("本町周辺全域から域から")).toBe("本町周辺全域から");
  });
  it("T4 助詞の重複: 新着でで次第 → 新着出次第", () => {
    expect(fix("新着でで次第お送りさせて頂きます")).toBe("新着出次第お送りさせて頂きます");
  });
  it("T5 句読点: 「！、」→「！」", () => {
    expect(fix("かしこまりました！、募集状況確認させて頂きます")).toBe("かしこまりました！募集状況確認させて頂きます");
  });
  it("T6 エスケープ漏れ: \\n → 改行", () => {
    expect(fix("かしこまりました！！\\n募集状況確認させて頂きます")).toBe("かしこまりました！！\n募集状況確認させて頂きます");
  });
  it("T7 曜日: 2026-07-23（水）→（木）（日付を正とする）", () => {
    expect(weekdayFor(7, 23, Date.parse("2026-07-20T03:00:00Z"))).toBe("木");
    expect(applyTypoAutoFix("7/23（水）の14時にご案内させて頂きます", { now: Date.parse("2026-07-20T03:00:00Z") }).text).toBe("7/23（木）の14時にご案内させて頂きます");
  });
});

describe("誤字として扱わない", () => {
  it("N1 「中でできる」「急いでも」「管理会社社内」「お部屋しちの」「で次第」「ご教授」は検出しない", () => {
    for (const s of ["お部屋の中でできる作業です", "急いでも大丈夫です", "管理会社社内で確認中です", "お部屋しちの", "新着で次第お送りさせて頂きます", "ご都合ご教授いただけましたら"]) {
      expect(detectTypos(s, { now: NOW }).length).toBe(0);
    }
  });
  it("N2 行末の「、、」（意図的な間）は検出しない", () => {
    expect(detectTypos("そうなんですね、、\nかしこまりました", { now: NOW }).length).toBe(0);
  });
  it("N3 名前に含まれる反復（めちめち）は誤字にしない", () => {
    expect(detectTypos("めちめちさんお世話になっております", { now: NOW, customerName: "めちめち" }).length).toBe(0);
  });
  it("N4 正しい曜日は検出しない（9/11（金）・9月14日(月)）", () => {
    expect(detectTypos("9/11（金）と9月14日(月)でご案内可能です", { now: NOW }).length).toBe(0);
  });
});

describe("最終チェックでの扱い（warning・修正ループ対象外）", () => {
  it("W1 置換先が決まらない誤字は TYPO_* warning で出て block しない", () => {
    const iss = runDeterministicChecks("ご確認頂きまら幸いです", { customerName: "佐藤", now: NOW }).filter((i) => i.code.startsWith("TYPO_"));
    expect(iss.length > 0).toBe(true);
    expect(iss.every((i) => i.severity === "warning")).toBe(true);
    expect(iss.some((i) => isRevisable(i))).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
