// app/lib/__tests__/estimate-body.test.ts
// 実行: npx tsx app/lib/__tests__/estimate-body.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内（H さん事例）「見積書の文…きめられた AIX のテンプレートの文の構成と違う」
// 材料は**本番の実物**（実送信365日 319通から読んだ形と、H さんの見積書の数字）。
import { buildEstimateItem, buildEstimateMessage, formatYen, roomSuffix, calcSavings, DAY_RENT_NOTE, NO_AMOUNT_FALLBACK } from "../estimate-body";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`\nexpected:\n${String(exp)}\ngot:\n${String(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が入っている`); },
  };
}

console.log("\n── 実送信の形をそのまま作れるか（365日 292通の主流）──");

it("割引あり＋節約あり（栄美グランドハイツ 211号室・実送信 2026-09-19）", () => {
  expect(buildEstimateMessage([{ propertyName: "栄美グランドハイツ", roomNumber: "211", discount: 12000, total: 107610, savings: 47520, accountName: "スモラ" }]))
    .toBe("【栄美グランドハイツ 211号室】\n\n初期費用さらに\n🌟12,000円割引させて頂き\n初期費用：107,610円\n\nスモラなら一般的な不動産業者より47,520円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。");
});

it("複数物件（ジーメゾン石津町東プリシェ＋フジパレス瓜破Ⅱ番館・実送信 2026-09-16）", () => {
  const out = buildEstimateMessage([
    { badge: "①", propertyName: "ジーメゾン石津町東プリシェ", roomNumber: "102", discount: 36000, total: 128980, savings: 111120, accountName: "スモラ" },
    { badge: "②", propertyName: "フジパレス瓜破Ⅱ番館", roomNumber: "305", discount: 31000, total: 156580, savings: 105020, accountName: "スモラ" },
  ]);
  expect(out).toContain("①【ジーメゾン石津町東プリシェ 102号室】");
  expect(out).toContain("②【フジパレス瓜破Ⅱ番館 305号室】");
  expect(out.split(DAY_RENT_NOTE).length - 1).toBe(1);   // 注記は最後に1回だけ
});

console.log("\n── ★ H さん事例: 割引0円でも節約行を落とさない ──");

// H さんの見積書（2026-09-20）: 家賃59,000 / 仲介手数料2,990 / 消費税0 / スモ割0 / 差引請求 178,090
//   見積書の画像には「スモラなら初期費用61,920円節約出来ます!!」と印字されている
const H_SAVINGS = calcSavings({ rent: 59000, commission: 2990, commissionTax: 0, discount: 0 });

it("節約額の式が見積書の印字と合う（59,000×1.1 − 2,990 ＝ 61,910）", () => {
  expect(H_SAVINGS).toBe(61910);
});

it("★ 割引0円でも「初期費用：」と「節約出来ます」の両方が出る", () => {
  const out = buildEstimateMessage([{ propertyName: "ハイツカトレア B", roomNumber: "202", discount: 0, total: 178090, savings: H_SAVINGS, accountName: "スモラ" }]);
  expect(out).toBe("【ハイツカトレア B 202号室】\n\n初期費用：178,090円\n\nスモラなら一般的な不動産業者より61,910円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。");
  expect(out).notToContain("割引させて");   // 0円割引は書かない
  expect(out).notToContain("🌟");
});

it("実送信の「割引なし＋節約あり」3通と同じ形（ROCCO 1201号室・2026-06-25）", () => {
  expect(buildEstimateMessage([{ propertyName: "ROCCO", roomNumber: "1201", discount: 0, total: 193630, savings: 66870, accountName: "スモラ" }]))
    .toBe("【ROCCO 1201号室】\n\n初期費用：193,630円\n\nスモラなら一般的な不動産業者より66,870円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。");
});

it("節約額も無ければ初期費用だけ（ウインズコート天神 304号室・2026-09-01）", () => {
  expect(buildEstimateMessage([{ propertyName: "ウインズコート天神", roomNumber: "304", discount: 0, total: 215050, savings: 0, accountName: "スモラ" }]))
    .toBe("【ウインズコート天神 304号室】\n\n初期費用：215,050円\n\n※ご入居日によって日割家賃が発生致します。");
});

console.log("\n── Vision が返す文字列（複数枚・物件確認の経路）──");

it("「36,000円」のような文字列をそのまま使える", () => {
  expect(buildEstimateMessage([{ propertyName: "テスト", roomNumber: "101", discount: "36,000円", total: "128,980円", savings: "111,120円", accountName: "スモラ" }]))
    .toContain("🌟36,000円割引させて頂き");
});

it("「円」が無い文字列には円を足す", () => {
  expect(formatYen("36,000")).toBe("36,000円");
  expect(formatYen("36,000円")).toBe("36,000円");
});

it("★ Vision が「0円」「0」「なし」を返したら割引行を出さない", () => {
  for (const v of ["0円", "0", "なし", "－", "", "  "]) expect(formatYen(v)).toBe(null);
  const out = buildEstimateMessage([{ propertyName: "テスト", roomNumber: "101", discount: "0円", total: "178,090円", savings: "61,910円", accountName: "スモラ" }]);
  expect(out).notToContain("割引させて");
  expect(out).toContain("節約出来ます");
});

console.log("\n── アカウント名（スモラ／イエヤス／ギガ賃貸）──");

it("アカウント名がそのまま節約行に入る", () => {
  for (const n of ["スモラ", "イエヤス", "ギガ賃貸"]) {
    expect(buildEstimateMessage([{ propertyName: "テスト", total: 100000, savings: 50000, accountName: n }]))
      .toContain(`${n}なら一般的な不動産業者より50,000円節約出来ます！！`);
  }
});

console.log("\n── 号室の付け方 ──");

it("「202」も「202号室」も同じ結果（号室を二重に付けない）", () => {
  expect(roomSuffix("202")).toBe(" 202号室");
  expect(roomSuffix("202号室")).toBe(" 202号室");
  expect(roomSuffix("")).toBe("");
  expect(roomSuffix(null)).toBe("");
});

it("号室が無ければ物件名だけ（ジーライズ髙石綾園 0103 のような形も壊さない）", () => {
  expect(buildEstimateItem({ propertyName: "ジーライズ髙石綾園 0103", total: 100000, accountName: "スモラ" }))
    .toBe("【ジーライズ髙石綾園 0103】\n\n初期費用：100,000円");
});

console.log("\n── 金額が読めない時（Vision 失敗・画像が見積書でない）──");

it("金額が1つも無ければ受け皿の1文に倒す（数字を作らない）", () => {
  const out = buildEstimateMessage([{ propertyName: "テスト", roomNumber: "101", accountName: "スモラ" }]);
  expect(out).toBe(`${NO_AMOUNT_FALLBACK}\n\n${DAY_RENT_NOTE}`);
  expect(out).notToContain("初期費用：");
  expect(out).notToContain("NaN");
  expect(out).notToContain("undefined");
});

it("物件が0件でも落ちない", () => {
  expect(buildEstimateMessage([])).toBe(`${NO_AMOUNT_FALLBACK}\n\n${DAY_RENT_NOTE}`);
});

it("読めた物件だけ残す（1枚目が失敗・2枚目が成功）", () => {
  const out = buildEstimateMessage([
    { badge: "①", propertyName: "読めなかった", accountName: "スモラ" },
    { badge: "②", propertyName: "読めた", roomNumber: "305", total: 156580, savings: 105020, accountName: "スモラ" },
  ]);
  expect(out).toContain("②【読めた 305号室】");
  expect(out).notToContain("読めなかった");
});

it("NaN・負の数・文字列の NaN で数字を作らない", () => {
  expect(formatYen(NaN)).toBe(null);
  expect(formatYen(-5000)).toBe(null);
  expect(formatYen(0)).toBe(null);
  const out = buildEstimateMessage([{ propertyName: "テスト", total: NaN, discount: -1, savings: NaN, accountName: "スモラ" }]);
  expect(out).notToContain("NaN");
  expect(out).toBe(`${NO_AMOUNT_FALLBACK}\n\n${DAY_RENT_NOTE}`);
});

console.log("\n── 節約額の式（見積書作成画面と AIX で同じ）──");

it("仲介手数料0円のアカウント（イエヤス）でも節約額が出る", () => {
  expect(calcSavings({ rent: 70000, commission: 0, commissionTax: 0, discount: 0 })).toBe(77000);
});

it("割引があれば節約額に足される", () => {
  expect(calcSavings({ rent: 59000, commission: 2990, commissionTax: 0, discount: 36000 })).toBe(97910);
});

it("家賃が読み取れなければ節約額は0（誤った金額を書かない側に倒す）", () => {
  expect(calcSavings({ rent: 0, commission: 2990, commissionTax: 299, discount: 0 })).toBe(0);
  expect(calcSavings({ rent: null, commission: null, commissionTax: null, discount: null })).toBe(0);
});

it("実際の手数料が標準より高くても負にならない", () => {
  expect(calcSavings({ rent: 50000, commission: 100000, commissionTax: 10000, discount: 0 })).toBe(0);
});

console.log("\n── 日割の注記 ──");

it("既定で付く（実送信 317/319通）", () => {
  expect(buildEstimateMessage([{ propertyName: "テスト", total: 100000, accountName: "スモラ" }])).toContain(DAY_RENT_NOTE);
});

it("入居日が確定している見積書作成画面では外せる", () => {
  expect(buildEstimateMessage([{ propertyName: "テスト", total: 100000, accountName: "スモラ" }], { dayRentNote: false })).notToContain(DAY_RENT_NOTE);
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
