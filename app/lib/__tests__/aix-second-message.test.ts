// app/lib/__tests__/aix-second-message.test.ts
// 実行: npx tsx app/lib/__tests__/aix-second-message.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { canOfferSecondMessage, withHonorific, buildSecondMessage } from "../aix-second-message";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
  };
}

it("2通目を出してよいのは 申込へ と 追客する→申込の催促 だけ", () => {
  expect(canOfferSecondMessage("application_push")).toBe(true);
  expect(canOfferSecondMessage("followup_revive", "apply_supplement")).toBe(true);
  // それ以外では出さない（内覧・物件送付・見積書 等に付くと別の場面で自動送信されてしまう）
  expect(canOfferSecondMessage("followup_revive", "other")).toBe(false);
  expect(canOfferSecondMessage("followup_revive")).toBe(false);
  expect(canOfferSecondMessage("viewing_invite")).toBe(false);
  expect(canOfferSecondMessage("property_send")).toBe(false);
  expect(canOfferSecondMessage("")).toBe(false);
  expect(canOfferSecondMessage(null)).toBe(false);
});

it("敬称: 既に さん／様 が付いていれば足さない・空はお客様", () => {
  expect(withHonorific("あい")).toBe("あいさん");
  expect(withHonorific("あいさん")).toBe("あいさん");
  expect(withHonorific("田中様")).toBe("田中様");
  expect(withHonorific("  タマキ  ")).toBe("タマキさん");
  expect(withHonorific("")).toBe("お客様");
  expect(withHonorific(null)).toBe("お客様");
});

it("本文はスタッフの実送信の型（2行・名前入り）", () => {
  const t = buildSecondMessage("あい");
  expect(t).toContain("ご不明点等出てきましたら何時でもお気軽にご質問ください");
  expect(t).toContain("あいさんがご満足いくご入居が出来ますよう全力でサポートさせて頂きます！！");
  expect(t.split("\n").length).toBe(2);
  expect(buildSecondMessage(null)).toContain("お客様がご満足いく");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
