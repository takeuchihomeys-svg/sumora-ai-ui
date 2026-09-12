// 2026-09-12 竹内方針A-3: 断言検査（ASSERTION_BAN_RULES・E6 VIEWING_BEFORE_VACANCY）の誤検出修正の回帰テスト。
// 実行: npx tsx app/lib/__tests__/assertion-ban.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { ASSERTION_BAN_RULES, findAssertionMatch, type AssertionBanCode } from "../validate-reply";
import { runDeterministicChecks } from "../final-check";
import { isMoveOutReleased, moveOutRoomMismatch } from "../move-out-context";
import { findConfirmObject } from "../confirmation-context";
import { allVacancyWordsAreSlots, isScheduleSlotVacancy } from "../scene-patterns";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}
const rule = (c: AssertionBanCode) => ASSERTION_BAN_RULES.find((r) => r.code === c)!;
const hits = (c: AssertionBanCode, t: string) => findAssertionMatch(rule(c), t) !== null;
const blocks = (t: string) => runDeterministicChecks(t, { customerName: "佐藤" }).filter((i) => i.severity === "block").map((i) => i.code);

describe("SCREENING_ASSURANCE", () => {
  it("S1 願望形「審査通りますようサポート」は断言ではない（7c80b31b 型）", () => expect(hits("SCREENING_ASSURANCE", "審査通りますようサポートさせて頂きます！！")).toBe(false));
  it("S2 願望形「審査面も通過出来ますようにサポート」（7a7c74f5 型）", () => expect(hits("SCREENING_ASSURANCE", "審査面も通過出来ますようにサポートさせて頂きます！！")).toBe(false));
  it("S3 願望形「審査無事通過出来ますよう弊社サポート」（24e89bc5 型）", () => expect(hits("SCREENING_ASSURANCE", "審査無事通過出来ますよう弊社サポートさせて頂きます！！")).toBe(false));
  it("S4 真陽性「審査も問題なく通過しますのでご安心ください」は block のまま（096825c8）", () => {
    expect(hits("SCREENING_ASSURANCE", "内定のご情報ございましたら審査も問題なく通過しますのでご安心ください！！")).toBe(true);
  });
  it("S5 真陽性「審査は通ります」", () => expect(hits("SCREENING_ASSURANCE", "こちらの物件でしたら審査は通ります！！")).toBe(true));
  it("S6 final-check でも願望形は block しない（後処理と検査が同じ関数）", () => expect(blocks("佐藤さん審査通りますようサポートさせて頂きます！！").includes("SCREENING_ASSURANCE")).toBe(false));
});

describe("VACANCY_ASSERTION", () => {
  it("V1 内覧枠「17:45～18:45のお時間のみ空いております」は空室の断言ではない（82e2d5cf）", () => {
    expect(hits("VACANCY_ASSERTION", "明日ですがお時間17:45～18:45のお時間のみ空いております！！")).toBe(false);
  });
  it("V2 真陽性「現在空いております」", () => expect(hits("VACANCY_ASSERTION", "こちらのお部屋現在空いております！！")).toBe(true));
  it("V3 真陽性「空室です」", () => expect(hits("VACANCY_ASSERTION", "こちら空室です！！")).toBe(true));
  it("V4 同じ文に内覧枠と空室の断言 → 空室側で一致", () => {
    expect(hits("VACANCY_ASSERTION", "明日のお時間空いております。お部屋も空室でございます")).toBe(true);
  });
  it("V5 final-check でも内覧枠は block しない", () => expect(blocks("佐藤さん明日ですが17時からのお時間空いております！！").includes("VACANCY_ASSERTION")).toBe(false));
});

describe("MOVEIN_DATE_ASSERTION", () => {
  it("M1 条件の並び「即入居可能・初期費用を…お部屋をピックアップ」は復唱（c31f7082）", () => {
    expect(hits("MOVEIN_DATE_ASSERTION", "大阪市内全域から即入居可能・初期費用を最大限抑えられるお部屋をピックアップさせて頂きます！！")).toBe(false);
  });
  it("M2 真陽性「9月1日からご入居いただけます」", () => expect(hits("MOVEIN_DATE_ASSERTION", "9月1日からご入居いただけます！！")).toBe(true));
  it("M3 真陽性「即入居可能です」", () => expect(hits("MOVEIN_DATE_ASSERTION", "こちら即入居可能です！！")).toBe(true));
});

describe("DISCLOSURE_ASSERTION", () => {
  it("D1 キャンセル手続きの「先方様とのトラブルは一切ございません」は告知事項ではない（99482059）", () => {
    expect(hits("DISCLOSURE_ASSERTION", "キャンセルのご連絡させて頂きましたが先方様とのトラブルは一切ございません！！")).toBe(false);
  });
  it("D2 真陽性「告知事項ございません」", () => expect(hits("DISCLOSURE_ASSERTION", "どちらも告知事項ございません！！")).toBe(true));
  it("D3 先方の話でも告知語を含めば block（「先方の物件は事故物件ではありません」）", () => {
    expect(hits("DISCLOSURE_ASSERTION", "先方に伺いましたが事故物件ではありません")).toBe(true);
  });
});

describe("E6 VIEWING_BEFORE_VACANCY の判定部品", () => {
  it("E1 直近スタッフに「内覧可能」→ 解除（route と final-check が同じ関数）", () => expect(isMoveOutReleased("管理会社に確認しましたところご内覧可能とのことです")).toBe(true));
  it("E2 解除語なし → 解除しない", () => expect(isMoveOutReleased("こちら10月末退去予定のお部屋となります")).toBe(false));
  it("E3 退去予定の根拠は203号室・本文は401号室 → 別の部屋（60b75de8）", () => {
    expect(moveOutRoomMismatch("スモラ:メロディハイム203号室は10月末退去予定となります", "401号室は申込が入っておりますが室内は確認可能です")).toBe(true);
  });
  it("E4 同じ号室 → 適用する", () => expect(moveOutRoomMismatch("スモラ:203号室は10月末退去予定です", "203号室ご内覧可能です")).toBe(false));
  it("E5 号室が片方に無い → 適用する（従来どおり）", () => expect(moveOutRoomMismatch("スモラ:10月末退去予定です", "401号室ご内覧可能です")).toBe(false));
});

describe("時間枠の「空いて」（scene-patterns 共有）", () => {
  it("T1 「明日ってまだ空いてますか」は内覧枠", () => expect(allVacancyWordsAreSlots("明日ってまだ空いてますか？彼氏がいけるみたいで")).toBe(true));
  it("T2 「この物件まだ空いてますか」は募集状況", () => expect(allVacancyWordsAreSlots("この物件まだ空いてますか？")).toBe(false));
  it("T3 findConfirmObject は内覧枠の質問を募集状況と読まない（82e2d5cf）", () => expect(findConfirmObject("明日ってまだ空いてますか？") === "募集状況").toBe(false));
  it("T4 findConfirmObject は空室の質問を募集状況と読む", () => expect(findConfirmObject("この物件まだ空いてますか？")).toBe("募集状況"));
  it("T5 isScheduleSlotVacancy 直前15字判定", () => expect(isScheduleSlotVacancy("9/9の15時空いてますか", 7)).toBe(true));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
