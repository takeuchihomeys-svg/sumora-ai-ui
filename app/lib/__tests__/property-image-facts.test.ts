// 物件資料の画像から「退去予定・条件（家賃・敷金・礼金）」を読む（竹内 2026-09-21）。
//
// 竹内「退去予定のところも可実装お願い／退去予定の物件を判断や、条件（家賃や敷金礼金などのところ）を
//   広げているのか物件ピックアップで文生成する際に画像を読み取ってそこから文はつくられているか」
//
// 読めた値は sent_properties の recruitment_status / rent に残すので、
// **次に文を作る時は画像を読み直さなくても**退去予定・家賃が分かる
// （竹内さん「文生成される部分毎回直さなくて済む（退去予定物件の部分等）」）。
//
// ⚠ 退去日の線は AIX【物件オススメ】のプロンプト（aix/action:1938）と同じにする:
//   備考欄の「解約予定／退去予定／解約日」が退去予定日。「現況／入居時期」は退去後に入居できる日。
//
// 実行: npx tsx app/lib/__tests__/property-image-facts.test.ts（全 PASS で exit 0）
import { parseReadResult, PROPERTY_IMAGE_PROMPT } from "../property-image-read";
import { resolveReadProperty } from "../property-name-match";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(item: unknown) { if (typeof actual === "string" ? !actual.includes(String(item)) : true) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`); },
  };
}

describe("読み取りの指示", () => {
  it("★ P1 退去予定日の線を明示する（備考欄／現況は使わない）", () => {
    expect(PROPERTY_IMAGE_PROMPT).toContain("解約予定");
    expect(PROPERTY_IMAGE_PROMPT).toContain("退去後に入居できる日");
  });
  it("★ P2 募集状況の語彙は sent_properties と同じ4つ", () => {
    for (const s of ["open", "move_out_planned", "under_construction", "occupied"]) {
      expect(PROPERTY_IMAGE_PROMPT).toContain(s);
    }
  });
  it("★ P3 条件（家賃・敷金・礼金）を読む", () => {
    expect(PROPERTY_IMAGE_PROMPT).toContain("rent");
    expect(PROPERTY_IMAGE_PROMPT).toContain("deposit");
    expect(PROPERTY_IMAGE_PROMPT).toContain("key_money");
  });
  it("P4 読めない項目を作らせない", () => {
    expect(PROPERTY_IMAGE_PROMPT).toContain("作らないこと");
    expect(PROPERTY_IMAGE_PROMPT).toContain("null か \"\" のまま");
  });
});

describe("読み取り結果を受ける", () => {
  it("★ R1 退去予定の物件を読む", () => {
    const r = parseReadResult(`{"items":[{"property_name":"スプランディッド大阪EAST","room_number":"204","rent":106000,"deposit":0,"key_money":0,"status":"move_out_planned","vacancy_date":"6月30日"}],"is_property":true}`);
    expect(r.items.length).toBe(1);
    expect(r.items[0].status).toBe("move_out_planned");
    expect(r.items[0].vacancyDate).toBe("6月30日");
    expect(r.items[0].rent).toBe(106000);
    expect(r.items[0].deposit).toBe(0);
    expect(r.items[0].keyMoney).toBe(0);
  });
  it("★ R2 読めない項目は null のまま（0 に丸めない＝敷金0円と区別する）", () => {
    const r = parseReadResult(`{"items":[{"property_name":"フォルモント寺田町","room_number":"304","rent":null,"deposit":null,"key_money":null,"status":"","vacancy_date":""}],"is_property":true}`);
    expect(r.items[0].rent).toBe(null);
    expect(r.items[0].deposit).toBe(null);
    expect(r.items[0].status).toBe(null);
    expect(r.items[0].vacancyDate).toBe(null);
  });
  it("★ R3 知らない募集状況の語は捨てる（勝手な値を入れない）", () => {
    const r = parseReadResult(`{"items":[{"property_name":"テスト","room_number":"101","status":"たぶん空室"}],"is_property":true}`);
    expect(r.items[0].status).toBe(null);
  });
  it("★ R4 退去予定日は「M月D日」の形だけ受ける（西暦付き・曖昧な語は捨てる）", () => {
    const a = parseReadResult(`{"items":[{"property_name":"テスト","room_number":"101","vacancy_date":"2026年6月30日"}]}`);
    expect(a.items[0].vacancyDate).toBe(null);
    const b = parseReadResult(`{"items":[{"property_name":"テスト","room_number":"101","vacancy_date":"来月末"}]}`);
    expect(b.items[0].vacancyDate).toBe(null);
    const c = parseReadResult(`{"items":[{"property_name":"テスト","room_number":"101","vacancy_date":"6月30日"}]}`);
    expect(c.items[0].vacancyDate).toBe("6月30日");
  });
  it("R5 「106,000円」のような表記も数字にする", () => {
    const r = parseReadResult(`{"items":[{"property_name":"テスト","room_number":"101","rent":"106,000円"}]}`);
    expect(r.items[0].rent).toBe(106000);
  });
  it("R6 日本語のキーでも受ける（モデルが形を変える事がある）", () => {
    const r = parseReadResult(`{"items":[{"物件名":"テスト","号室":"101","賃料":"8万","敷金":"0"}]}`);
    expect(r.items[0].propertyName).toBe("テスト");
    expect(r.items[0].deposit).toBe(0);
  });
  it("R7 建築中も読める（内覧できない物件の判断に使う）", () => {
    const r = parseReadResult(`{"items":[{"property_name":"テスト","room_number":"101","status":"under_construction"}]}`);
    expect(r.items[0].status).toBe("under_construction");
  });
  it("R8 物件でない画像は items が空（見積書・身分証）", () => {
    const r = parseReadResult(`{"items":[],"is_property":false}`);
    expect(r.items.length).toBe(0);
    expect(r.isProperty).toBe(false);
  });
});

describe("照合しても読んだ値が消えない", () => {
  it("★ M1 物件名は既知の名前に寄せ、退去予定・家賃はそのまま残る", () => {
    const read = { propertyName: "スプレンディッド大阪EAST", roomNumber: "0204", rent: 106000, deposit: 0, keyMoney: 0, status: "move_out_planned", vacancyDate: "6月30日" };
    const fixed = resolveReadProperty(read, ["スプランディッド大阪EAST"]);
    if (!fixed) throw new Error("照合が通らなかった");
    expect(fixed.propertyName).toBe("スプランディッド大阪EAST");
    expect(fixed.roomNumber).toBe("204");          // 先頭ゼロは落ちる
    expect(fixed.status).toBe("move_out_planned");  // ← 消えない
    expect(fixed.rent).toBe(106000);
    expect(fixed.vacancyDate).toBe("6月30日");
  });
  it("M2 名前が既知と合わなければ null（誤読を記録しない）", () => {
    expect(resolveReadProperty({ propertyName: "全然ちがう物件", roomNumber: "101", status: "open" }, ["スプランディッド大阪EAST"])).toBe(null);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
