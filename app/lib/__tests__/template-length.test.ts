// AIX テンプレート（2通目）の長さの目安（竹内「生成される文が長すぎる」）。
//
// 実測（scripts/audit-template-length.ts・直近120日）が根拠:
//   実送信の2通目 1,419通: 中央値 120字・4行
//   **成約した会話の2通目 114通: 中央値 108字・3行**（25% 65 / 75% 140）
//   分布: 0〜60字 19.2% / 60〜100字 16.0% / **100〜140字 34.3%（最頻）** /
//         140〜180字 8.3% / 180〜240字 6.3% / 240字〜 15.8% ＝ **140字未満が69.5%**
//   生成が長い経路: property_recommendation 生成257字→実送信234字 ／ property_send_widen 生成170字→実送信112字
//
// 実行: npx tsx app/lib/__tests__/template-length.test.ts（全 PASS で exit 0）
import { buildLengthNote, checkLength, isLengthGuided, TEMPLATE_LENGTH_GUIDE, LENGTH_FREE_ACTIONS } from "../template-length";

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

// 竹内さんが見せた実物（和樹さん・21:21 の2通目）＝ 目指す形
const REAL_2ND = "お送りさせて頂きましたお部屋の中でもジーメゾン泉大津ペルファットが特に和樹さんにオススメのお部屋となります！！\nペット2匹飼育可能となります😊！！\n和樹さん達がお気に召されたお部屋ご内覧させて頂きますのでお気軽にお申し付けください😌！！";

describe("長さを縛る種類", () => {
  for (const a of ["property_recommendation", "property_send", "estimate_sheet", "property_check_result", "viewing_invite", "meeting_place", "property_send_widen"]) {
    it(`G ${a} は縛る`, () => { expect(isLengthGuided(a)).toBe(true); });
  }
  it("★ G8 種類が分からない時も縛る（長い方に倒さない）", () => {
    expect(isLengthGuided(null)).toBe(true);
    expect(isLengthGuided("")).toBe(true);
    expect(isLengthGuided("unknown_action")).toBe(true);
  });
});

describe("長さを縛らない種類（フォームの全文を送る）", () => {
  for (const a of ["condition_hearing", "application_push_format", "document_request"]) {
    it(`F ${a} は縛らない`, () => {
      expect(isLengthGuided(a)).toBe(false);
      expect(buildLengthNote(a)).toBe("");
    });
  }
  it("F4 一覧は空でない（配線事故の検知）", () => { expect(LENGTH_FREE_ACTIONS.size >= 3).toBe(true); });
});

describe("プロンプトに入れる指示", () => {
  it("★ N1 実測の数字を根拠として見せる（成約108字・3行）", () => {
    const n = buildLengthNote("property_recommendation");
    expect(n).toContain("108字");
    expect(n).toContain("140字未満が69.5%");
  });
  it("★ N2 上限を明示して「超えたら書き直す」と言う", () => {
    expect(buildLengthNote("property_send")).toContain("180字を超えたら書き直す");
  });
  it("★ N3 長くなる原因（箇条書きの並べ直し）を名指しで止める", () => {
    const n = buildLengthNote("property_recommendation");
    expect(n).toContain("次の一歩1つ");
    expect(n).toContain("箇条書きで並べ直さない");
  });
});

describe("長さの点検（実物で確かめる）", () => {
  it(`★ C1 竹内さんの実物（${REAL_2ND.length}字・3行）は基準内`, () => {
    const r = checkLength(REAL_2ND, "property_recommendation");
    expect(r.ok).toBe(true);
    expect(r.over).toBe(0);
  });
  it("★ C2 実測で長かった生成（257字相当）は基準外として記録される", () => {
    const long = "あ".repeat(257);
    const r = checkLength(long, "property_recommendation");
    expect(r.ok).toBe(false);
    expect(r.over).toBe(257 - TEMPLATE_LENGTH_GUIDE.max);
  });
  it("C3 フォーム系は長くても基準内（縛らない）", () => {
    expect(checkLength("あ".repeat(400), "condition_hearing").ok).toBe(true);
  });
  it("★ C4 点検は本文を書き換えない（長さで切ると文が壊れる）", () => {
    const r = checkLength(REAL_2ND, "property_recommendation");
    // 返すのは測った値だけ。text を返さない設計であることを型で固定する
    expect(Object.keys(r).sort().join(",")).toBe("len,lines,ok,over");
  });
  it("C5 成約データの中央値108字は基準の内側", () => {
    expect(checkLength("あ".repeat(108), "property_send").ok).toBe(true);
  });
  it("C6 実送信の75パーセンタイル140字も基準の内側", () => {
    expect(checkLength("あ".repeat(140), "property_send").ok).toBe(true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
