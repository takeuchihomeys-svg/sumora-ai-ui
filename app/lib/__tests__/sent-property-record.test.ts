// 「どの物件を送ったか」を記録する時の判断（重複・退去予定）。
//
// 2026-09-20 竹内「物件ピックアップから送る物件もテーブルかクエリで保管したら…
//   一度送った物件が間違えって入ってしまうこと防げる（アナウンスがでる）」
//
// テストの材料は **実データ**（scripts/audit-sent-properties.ts が出した重複の実物）を使う:
//   dd34f5b0… グランパシフィック生野東 501×5 / グランバシフィック生野東 501×2  ← パ/バ の誤読で別物扱いされていた
//   8b5a777e… アドバンス難波南ワイズ 0403×2                                    ← 先頭ゼロ
//   719c1854… グラシコート 00201×2 / ハイム北野 405×3 / サンモール木川 203×4
// 別物の例（property-name-match の知見）: グランパシフィック生野東 ↔ グランパシフィック梅南 = 0.76
//
// 実行: npx tsx app/lib/__tests__/sent-property-record.test.ts（全 PASS で exit 0）
import {
  toRecruitmentStatus, normalizeRoomNo, isSameProperty, findAlreadySent,
  buildDuplicateNotice, buildSentPropertyRows,
} from "../sent-property-record";

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
const P = (property_name: string, room_no: string | null = null) => ({ property_name, room_no });

describe("退去予定をデータで持つ（竹内「退去予定物件の部分等」）", () => {
  it("R1 vacating → move_out_planned", () => { expect(toRecruitmentStatus("vacating")).toBe("move_out_planned"); });
  it("R2 available → open", () => { expect(toRecruitmentStatus("available")).toBe("open"); });
  it("R3 unavailable → occupied", () => { expect(toRecruitmentStatus("unavailable")).toBe("occupied"); });
  it("R4 alternative はその物件自体の状態ではないので入れない", () => { expect(toRecruitmentStatus("alternative")).toBe(null); });
  it("R5 空・未知は null（推測で埋めない）", () => {
    expect(toRecruitmentStatus("")).toBe(null);
    expect(toRecruitmentStatus(undefined)).toBe(null);
    expect(toRecruitmentStatus("なんか")).toBe(null);
  });
});

describe("号室の表記ゆれ（実データの先頭ゼロ）", () => {
  it("N1 「0403」と「403」は同じ部屋", () => { expect(normalizeRoomNo("0403")).toBe(normalizeRoomNo("403")); });
  it("N2 「00201」と「201」は同じ部屋", () => { expect(normalizeRoomNo("00201")).toBe("201"); });
  it("N3 「403号室」も「403」", () => { expect(normalizeRoomNo("403号室")).toBe("403"); });
  it("N4 全角「４０３」も「403」", () => { expect(normalizeRoomNo("４０３")).toBe("403"); });
  it("N5 空は空（無いことを無いままにする）", () => { expect(normalizeRoomNo(null)).toBe(""); });
});

describe("同じ物件か（実データの重複）", () => {
  it("D1 同じ物件・同じ号室は重複", () => {
    expect(isSameProperty(P("フォルモント寺田町", "304"), P("フォルモント寺田町", "304"))).toBe(true);
  });
  it("D2 先頭ゼロ違いは同じ（アドバンス難波南ワイズ 0403 ↔ 403）", () => {
    expect(isSameProperty(P("アドバンス難波南ワイズ", "0403"), P("アドバンス難波南ワイズ", "403"))).toBe(true);
  });
  it("★ D3 シリーズ名が同じ別物件は重複にしない（生野東 ↔ 梅南 = 0.762）", () => {
    expect(isSameProperty(P("グランパシフィック生野東", "501"), P("グランパシフィック梅南", "501"))).toBe(false);
  });
  it("★ D3b 画像の誤読（パ/バ = 0.818）も拾わない — 別物件 0.762 と 0.06 しか離れておらず線が引けない", () => {
    // 誤読を直すのは resolveReadProperty（会話の物件名を辞書にした照合）の担当。
    // ここで拾おうとすると 0.70 まで下げることになり、名前が違う物を48組巻き込む（実測）。
    expect(isSameProperty(P("グランパシフィック生野東", "501"), P("グランバシフィック生野東", "501"))).toBe(false);
  });
  it("D4 同じ建物でも号室が違えば別（ハイム北野 405 ↔ 406）", () => {
    expect(isSameProperty(P("ハイム北野", "405"), P("ハイム北野", "406"))).toBe(false);
  });
  it("D5 号室が無くても別物件は重複と言わない（0.762）", () => {
    expect(isSameProperty(P("グランパシフィック生野東"), P("グランパシフィック梅南"))).toBe(false);
  });
  it("★ D7 号室が同じでも名前が全然違えば別物件（実データ: 201号室に3物件）", () => {
    expect(isSameProperty(P("アッシュメゾン加美正覚寺V", "201"), P("Itmaison塚住泊Ⅱ", "201"))).toBe(false);
    expect(isSameProperty(P("コル・デ・ソル杭全", "101"), P("小路東一戸建", "101"))).toBe(false);
  });
  it("D8 空白の有無は吸収する（実データ 1.000 のペア）", () => {
    expect(isSameProperty(P("エステムコートみなと元町THE FIRST", "801"), P("エステムコート みなと元町THE FIRST", "801"))).toBe(true);
  });
  it("D6 号室が無くても名前がほぼ同じなら重複（表記ゆれ）", () => {
    expect(isSameProperty(P("スプランディッド大阪EAST"), P("スプランディッド大阪ＥＡＳＴ"))).toBe(true);
  });
});

describe("アナウンス（竹内「アナウンスがでる」）", () => {
  const existing = [P("フォルモント寺田町", "304"), P("メゾンルクレール中津", "405")];
  it("★ A1 既に送った物件が混ざっていたら知らせる", () => {
    const dups = findAlreadySent(existing, [P("フォルモント寺田町", "304"), P("新しい物件", "101")]);
    expect(dups.length).toBe(1);
    const notice = buildDuplicateNotice(dups);
    expect(notice).toContain("フォルモント寺田町");
    expect(notice).toContain("既にこのお客様へお送りしています");
  });
  it("A2 新しい物件だけなら何も言わない（無条件にアナウンスしない）", () => {
    expect(buildDuplicateNotice(findAlreadySent(existing, [P("新しい物件", "101")]))).toBe("");
  });
  it("A3 送るものが空なら何も言わない", () => {
    expect(buildDuplicateNotice(findAlreadySent(existing, []))).toBe("");
  });
  it("A4 既に送った物が1件も無い（初回）なら何も言わない", () => {
    expect(buildDuplicateNotice(findAlreadySent([], [P("フォルモント寺田町", "304")]))).toBe("");
  });
});

describe("AIX の並行配列を行にする", () => {
  it("★ B1 物件名＋状態を対応付けて、退去予定が残る", () => {
    const rows = buildSentPropertyRows({
      conversationId: "c1",
      names: ["アーバネックス本町II 1005号室", "スプランディッド堀江 403号室"],
      statuses: ["vacating", "available"],
      source: "aix:property_send",
    });
    expect(rows.length).toBe(2);
    expect(rows[0].property_name).toBe("アーバネックス本町II");
    expect(rows[0].room_no).toBe("1005");
    expect(rows[0].recruitment_status).toBe("move_out_planned");
    expect(rows[1].recruitment_status).toBe("open");
    expect(rows[0].source).toBe("aix:property_send");
  });
  it("B2 号室が名前に無ければ空のまま（作らない）", () => {
    const rows = buildSentPropertyRows({ conversationId: "c1", names: ["生野西一丁目戸建"], source: "aix:property_send" });
    expect(rows[0].room_no).toBe("");
    expect(rows[0].property_name).toBe("生野西一丁目戸建");
  });
  it("B3 状態が渡らなければ recruitment_status は null（推測で埋めない）", () => {
    const rows = buildSentPropertyRows({ conversationId: "c1", names: ["プロスペリテ 306号室"], source: "staff_image" });
    expect(rows[0].recruitment_status).toBe(null);
  });
  it("B4 空の要素は落とす（空の行を作らない）", () => {
    const rows = buildSentPropertyRows({ conversationId: "c1", names: ["", null, undefined, "  ", "ハイム北野 405号室"], source: "x" });
    expect(rows.length).toBe(1);
  });
  it("B5 行に delivery と channel が入る（source から導く・2026-09-24）", () => {
    const a = buildSentPropertyRows({ conversationId: "c1", names: ["プロスペリテ 306号室"], source: "aix:property_check_result" });
    expect(a[0].delivery).toBe("customer");
    expect(a[0].channel).toBe("check");
    const b = buildSentPropertyRows({ conversationId: "c1", names: ["プロスペリテ 306号室"], source: "aix:property_recommendation" });
    expect(b[0].channel).toBe("recommendation");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
