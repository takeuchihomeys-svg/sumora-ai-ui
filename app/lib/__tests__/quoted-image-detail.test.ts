// 引用先の画像の読み取り（2026-09-21 竹内「引用とあれば引用先の画像を読み取れるようにする」）
//
// 実物の場面: Hina「ここの駐車所って１階ですか？」← [引用][画像]（こちらが送ったアービングNeo岸里玉出402号室の資料）
//   今までは「どの物件か」までしか渡らず、資料に書いてある事（駐車場・ペット・保証会社）は1文字も渡っていなかった。
//   実測（直近120日・こちらが送った画像への引用返信133件）: 資料を読まないと答えられない質問 44件（33.1%）、
//   そのうち **75% はスタッフが確認を挟まずその場で答えていた**（手元の資料を見て即答している）。
//
// 実行: npx tsx app/lib/__tests__/quoted-image-detail.test.ts（全 PASS で exit 0）
import { parseDetailResult } from "../property-image-read";
// ⚠ quoted-context.ts は DB（supabase）を読むので、テストは純関数だけの quoted-note.ts に当てる
import { formatQuotedDetailBlock, describeQuotedTarget, buildQuotedReplyNote, type QuotedContext } from "../quoted-note";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)} in ${JSON.stringify(String(actual).slice(0, 200))}`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`expected NOT to contain ${JSON.stringify(sub)}`); },
  };
}

const ctx = (over: Partial<QuotedContext> = {}): QuotedContext => ({
  customerText: "ここの駐車所って１階ですか？",
  quotedSender: "staff",
  quotedText: null,
  isImage: true,
  propertyLabel: "アービングNeo岸里玉出 402号室",
  detailLines: [],
  detailKind: null,
  ...over,
});

describe("★★ 読み取り結果の取り出し（parseDetailResult）", () => {
  it("★★ P1 物件の資料は「項目: 値」の行を残す", () => {
    const r = parseDetailResult(`{"kind":"property","lines":["駐車場: 敷地内 空有","ペット: 小型犬・猫可","保証会社: 日本セーフティー"]}`);
    expect(r.kind).toBe("property");
    expect(r.lines.length).toBe(3);
    expect(r.lines[0]).toBe("駐車場: 敷地内 空有");
  });
  it("★★ P2 見積書は中身を書き出さない（金額を材料にしない）", () => {
    const r = parseDetailResult(`{"kind":"estimate","lines":["初期費用合計: 531,730円"]}`);
    expect(r.kind).toBe("estimate");
    expect(r.lines.length).toBe(0);
  });
  it("★★ P3 本人確認書類も中身を書き出さない", () => {
    const r = parseDetailResult(`{"kind":"document","lines":["氏名: 〇〇","生年月日: 〇年〇月〇日"]}`);
    expect(r.kind).toBe("document");
    expect(r.lines.length).toBe(0);
  });
  it("★★ P4 「不明」「記載なし」の行は材料にしない（AI が『記載なし』と答えてしまう）", () => {
    const r = parseDetailResult(`{"kind":"property","lines":["駐車場: 空有","ペット: 記載なし","楽器: 不明","駐輪場: -"]}`);
    expect(r.lines.length).toBe(1);
    expect(r.lines[0]).toBe("駐車場: 空有");
  });
  it("P5 「項目: 値」でない地の文は落とす", () => {
    const r = parseDetailResult(`{"kind":"property","lines":["この物件はとても綺麗です","間取り: 1LDK"]}`);
    expect(r.lines.length).toBe(1);
    expect(r.lines[0]).toBe("間取り: 1LDK");
  });
  it("P6 ```json で囲まれていても読む", () => {
    const r = parseDetailResult("```json\n{\"kind\":\"property\",\"lines\":[\"間取り: 2LDK\"]}\n```");
    expect(r.kind).toBe("property");
    expect(r.lines[0]).toBe("間取り: 2LDK");
  });
  it("★ P7 壊れた応答・空応答でも落ちない（推論で使い切った時）", () => {
    for (const s of ["", "   ", "{\"kind\":\"property\",", "考え中..."]) {
      const r = parseDetailResult(s);
      expect(r.kind).toBe("other");
      expect(r.lines.length).toBe(0);
    }
  });
  it("P8 知らない kind は other 扱いにして中身を捨てる", () => {
    const r = parseDetailResult(`{"kind":"まいそく","lines":["間取り: 1K"]}`);
    expect(r.kind).toBe("other");
    expect(r.lines.length).toBe(0);
  });
  it("P9 行数は20行まで", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `項目${i}: 値`);
    const r = parseDetailResult(JSON.stringify({ kind: "property", lines }));
    expect(r.lines.length).toBe(20);
  });
});

describe("★★ 材料の文（formatQuotedDetailBlock）", () => {
  it("★★ D1 読み取りが無ければ何も足さない", () => {
    expect(formatQuotedDetailBlock([], "アービングNeo岸里玉出 402号室")).toBe("");
  });
  it("★★ D2 書いてある事はその場で答えてよい・無い事は確認で受ける、が両方入る", () => {
    const b = formatQuotedDetailBlock(["駐車場: 敷地内 空有", "ペット: 不可"], "スプランディッド堀江 403号室");
    expect(b).toContain("駐車場: 敷地内 空有");
    expect(b).toContain("その場で答えてよい");
    expect(b).toContain("確認させて頂きます");
    expect(b).toContain("スプランディッド堀江 403号室");
  });
  it("★ D3 金額・住所は本文に書かせない一文が必ず入る", () => {
    expect(formatQuotedDetailBlock(["間取り: 1LDK"], null)).toContain("本文に書かない");
  });
});

describe("★★ 引用先の説明（describeQuotedTarget）", () => {
  it("★★ Q1 こちらの画像は物件名つきで説明する", () => {
    expect(describeQuotedTarget(ctx())).toContain("アービングNeo岸里玉出 402号室");
  });
  it("★★ Q2 お客様が送った画像の書き起こしは「お客様の発言ではない」と添える", () => {
    const d = describeQuotedTarget(ctx({ isImage: false, quotedSender: "customer", propertyLabel: null, quotedText: "[画像] **物件名** セレニテ阿倍野 **賃料** 6万円" }));
    expect(d).toContain("写っていた文字");
    expect(d).toContain("お客様の発言ではない");
  });
  it("Q3 ふつうの文はそのまま「」で渡す", () => {
    expect(describeQuotedTarget(ctx({ isImage: false, quotedText: "9/21(月) 15:00〜17:00にてご案内可能です" })))
      .toContain("「9/21(月) 15:00〜17:00にてご案内可能です」");
  });
});

describe("★★ 返信生成に渡す引用の説明（buildQuotedReplyNote）", () => {
  const opts = { linkOrPhotoRequest: false, estimateAllowed: false };
  it("Q4 引用が無ければ空文字（材料を足さない）", () => {
    expect(buildQuotedReplyNote(null, opts)).toBe("");
  });
  it("★★ Q5 資料の読み取りが材料として入る", () => {
    const note = buildQuotedReplyNote(ctx({ detailKind: "property", detailLines: ["駐車場: 敷地内 空有 23000円", "駐輪場: 有"] }), opts);
    expect(note).toContain("駐車場: 敷地内 空有 23000円");
    expect(note).toContain("引用リプライ検出");
  });
  it("★★ Q6 画像の引用では物件名を本文に書かせない（読み取りが誤っている事があるため）", () => {
    expect(buildQuotedReplyNote(ctx(), opts)).toContain("物件名・マンション名は書かないこと");
  });
  it("★ Q7 文の引用では物件名を書くなの注意は出さない", () => {
    expect(buildQuotedReplyNote(ctx({ isImage: false, quotedText: "お部屋ご案内させて頂きます" }), opts))
      .notToContain("物件名・マンション名は書かないこと");
  });
  it("★★ Q8 URL・写真を求められている時は URL を送る文を禁止する", () => {
    expect(buildQuotedReplyNote(ctx(), { linkOrPhotoRequest: true, estimateAllowed: false }))
      .toContain("URLをお送りします");
  });
  it("★ Q9 費用の質問が無い時は見積書の宣言を書かせない", () => {
    expect(buildQuotedReplyNote(ctx(), opts)).toContain("見積書の宣言は書かない");
  });
  it("★ Q10 費用の質問がある時は御見積書の言い回しを見せる", () => {
    expect(buildQuotedReplyNote(ctx(), { linkOrPhotoRequest: false, estimateAllowed: true }))
      .toContain("最大限割引した初期費用の御見積書");
  });
  it("★★ Q11 見積書の画像を引用された時は中身が入らない（kind が property でない）", () => {
    // resolveLatestQuotedContext は estimate の時 detailLines を空にする。ここはその前提の確認
    const note = buildQuotedReplyNote(ctx({ detailKind: "estimate", detailLines: [] }), opts);
    expect(note).notToContain("書いてある事");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
