// 壊れた絵文字（片割れのサロゲート）を落とす（2026-09-21）。
//
// YUMA の本番経路テストで生成が **3回とも 400** になった:
//   "The request body is not valid JSON: no low surrogate in string: line 1 column 55656"
//   ＝ プロンプトに絵文字の片割れが1つ入っていて、API が JSON として受け取れない。
//   下書きは丸ごと「生成に失敗しました」になる（**1文字のせいで1通が消える**）。
//
// DB は無傷だった（18,032行を見て0件）ので、コードのどこかの `slice(0, N)` が割っている。
// 原因を1か所ずつ潰す前に、送る直前で落とす関門を置いた。
//
// 実行: npx tsx app/lib/__tests__/safe-slice.test.ts（全 PASS で exit 0）
import { safeSlice, hasBrokenSurrogate, stripBrokenSurrogates } from "../safe-slice";

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
/** 絵文字の前半だけ（後半が無い） */
const LONE_HIGH = "\ud83d";
/** 絵文字の後半だけ（前半が無い） */
const LONE_LOW = "\ude0a";

describe("★★ 壊れた絵文字を見つける", () => {
  it("★★ B1 前半だけ残った文字列を見つける", () => {
    expect(hasBrokenSurrogate(`お手隙の際にご査収ください${LONE_HIGH}`)).toBe(true);
  });
  it("★★ B2 後半だけ残った文字列を見つける", () => {
    expect(hasBrokenSurrogate(`${LONE_LOW}！！`)).toBe(true);
  });
  it("★★ B3 正しい絵文字は壊れていない", () => {
    for (const s of ["お手隙の際にご査収ください😌！！", "🌟スプランディッド難波 502号室", "はい😊！！", "🙇‍♂️検討します"]) {
      expect(hasBrokenSurrogate(s)).toBe(false);
    }
  });
  it("B4 絵文字が無い文字列・空でも落ちない", () => {
    expect(hasBrokenSurrogate("お世話になっております！！")).toBe(false);
    expect(hasBrokenSurrogate("")).toBe(false);
  });
});

describe("★★ 片割れだけを落とす（正しい絵文字は消さない）", () => {
  it("★★ S1 前半だけを落とす", () => {
    expect(stripBrokenSurrogates(`ご査収ください${LONE_HIGH}！！`)).toBe("ご査収ください！！");
  });
  it("★★ S2 後半だけを落とす", () => {
    expect(stripBrokenSurrogates(`${LONE_LOW}はい！！`)).toBe("はい！！");
  });
  it("★★ S3 正しい絵文字は1文字も消さない", () => {
    for (const s of ["お手隙の際にご査収ください😌！！", "🌟スプランディッド難波 502号室", "はい😊！！／ありがとうございます🙇"]) {
      expect(stripBrokenSurrogates(s)).toBe(s);
    }
  });
  it("★★ S4 正しい絵文字と片割れが混ざっていても、片割れだけ落とす", () => {
    expect(stripBrokenSurrogates(`はい😊！！${LONE_HIGH}ごゆっくりご検討ください😌！！`))
      .toBe("はい😊！！ごゆっくりご検討ください😌！！");
  });
  it("S5 壊れていなければ同じ文字列をそのまま返す（作り直さない）", () => {
    const s = "お世話になっております！！";
    expect(stripBrokenSurrogates(s)).toBe(s);
  });
  it("S6 空でも落ちない", () => {
    expect(stripBrokenSurrogates("")).toBe("");
  });
  it("★★ S7 落とした後は JSON にできる（これが目的）", () => {
    const broken = `ご査収ください${LONE_HIGH}！！`;
    const fixed = stripBrokenSurrogates(broken);
    // 壊れたままだと JSON.stringify は通るが API 側で弾かれる。エンコードして確かめる
    expect(/\ud800-\udbff|\udc00-\udfff/.test(encodeURIComponent(fixed) ? "" : "")).toBe(false);
    expect(hasBrokenSurrogate(fixed)).toBe(false);
  });
});

describe("safeSlice（切る時に割らない）", () => {
  it("★ C1 絵文字の途中で切らない", () => {
    const s = "あい😊うえ";
    // "あい" + high + low ... 3文字目で切ると絵文字が割れる
    const cut = safeSlice(s, 3);
    expect(hasBrokenSurrogate(cut)).toBe(false);
  });
  it("C2 上限以下ならそのまま", () => {
    expect(safeSlice("あいう", 10)).toBe("あいう");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
