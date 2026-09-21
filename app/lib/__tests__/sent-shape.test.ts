// 実送信の形（何卒の有無・改行）を材料にする（竹内 2026-09-21）。
//
// 竹内「何卒よろしくお願い致します！！ で文終わる場面と、いれない場面あるからそこの違いもちゃんと学習する」
// 竹内「文の改行している場所を実際の送っている文から特徴把握して改善する」
//
// ⚠ テストに使う本文は実送信の形をそのまま使う。
// 実行: npx tsx app/lib/__tests__/sent-shape.test.ts（全 PASS で exit 0）
import {
  classifySentKind, buildSentShapeNote, buildSentShapeNoteAll, checkSentShape,
  NANITOZO_RATE, SHAPE, LINE_CHARS_P90,
} from "../sent-shape";

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
    notToContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected ${JSON.stringify(actual)} NOT to contain ${JSON.stringify(item)}`); },
  };
}

// 実送信（直近180日）から取った実物
const MEETING = "かしこまりました！！\n9/8（火）ご案内させて頂きます！！\n\n9/8 15:00にウェルスクエア池田井口堂 \n現地エントランスお待ち合わせで何卒よろしくお願い致します！！";
const CARD = "🌟パルビゾン箕面 203\n\n水回りリノベーション、かなりオススメ出来るお部屋となります！！\n\n（オススメポイント）\n・家賃85,000円・管理費5,000円";
const ESTIMATE = "【ハイツカトレア B 202号室】\n\n初期費用さらに\n🌟30,000円割引させて頂き\n初期費用：148,090円";
const RECEIVE = "お待たせ致しました！！\n\n難波周辺からオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";
const PICKUP = "かしこまりました！！\n塚本・大国町エリアでもオススメ出来るお部屋ピックアップさせて頂きます！！\nピックアップ出来次第ご連絡させて頂きます😌！！";
const SHORT = "はい😊！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！";

describe("返信の種類を分ける（監査と同じ順番）", () => {
  it("★ K1 内覧の待ち合わせ", () => expect(classifySentKind(MEETING)).toBe("内覧の待ち合わせ"));
  it("★ K2 物件カード（🌟の行）", () => expect(classifySentKind(CARD)).toBe("物件カード"));
  it("★ K3 見積書", () => expect(classifySentKind(ESTIMATE)).toBe("見積書"));
  it("★ K4 ご査収（物件・書類の送付）", () => expect(classifySentKind(RECEIVE)).toBe("物件・書類の送付（ご査収）"));
  it("★ K5 ピックアップの約束", () => expect(classifySentKind(PICKUP)).toBe("ピックアップの約束"));
  it("★ K6 短い返し（60字以内）", () => expect(classifySentKind(SHORT)).toBe("短い返し"));
  it("K7 画像・URLのみ", () => {
    expect(classifySentKind("[画像]")).toBe("画像・URLのみ");
    expect(classifySentKind("https://example.com/a.pdf")).toBe("画像・URLのみ");
  });
  it("K8 空文字でも落ちない", () => expect(classifySentKind("")).toBe("短い返し"));
});

describe("渡す材料の文", () => {
  it("★ N1 内覧の待ち合わせは「付ける方が普通」（実測64.3%）", () => {
    const n = buildSentShapeNote("内覧の待ち合わせ");
    expect(n).toContain("64.3%");
    expect(n).toContain("付ける方が普通");
  });
  it("★ N2 ピックアップの約束は「付けない方が普通」（実測22.6%）", () => {
    const n = buildSentShapeNote("ピックアップの約束");
    expect(n).toContain("22.6%");
    expect(n).toContain("付けない方が普通");
  });
  it("★ N3 実送信がほぼ0の場面だけ「付けない」と言い切る（物件カード0.3%・ご査収1.3%・画像0%）", () => {
    for (const k of ["物件カード", "画像・URLのみ", "物件・書類の送付（ご査収）"] as const) {
      const n = buildSentShapeNote(k);
      expect(n).toContain("ほぼ0");
      expect(n).toContain("**付けない**");
      expect(n).notToContain("付ける方が普通");
    }
  });
  it("★ N3-2 見積書（2.0%＝17/861）は言い切らない（実送信に本当にある形は禁止にしない）", () => {
    const n = buildSentShapeNote("見積書");
    expect(n).notToContain("ほぼ0");
    expect(n).toContain("付けない方が普通");
  });
  it("★ N4 付けるなら最終行と言う（実測86.1%）", () => {
    expect(buildSentShapeNote("内覧の待ち合わせ")).toContain("86.1%");
    expect(buildSentShapeNote("内覧の待ち合わせ")).toContain("最終行");
  });
  it("★ N5 改行の型を数字で渡す（場面ごとの中央値）", () => {
    const n = buildSentShapeNote("短い返し");
    expect(n).toContain(`**${SHAPE["短い返し"].lines}行**`);
    expect(n).toContain(`**${SHAPE["短い返し"].lineChars}字**`);
    expect(n).toContain("空行なし");
  });
  it("★ N6 空行を使う場面は空行の数まで言う", () => {
    expect(buildSentShapeNote("物件カード")).toContain("空行を5つ");
  });
  it("★ N7 1行が長い時の切り方を言う（上位10%の線）", () => {
    expect(buildSentShapeNote("その他")).toContain(String(LINE_CHARS_P90));
    expect(buildSentShapeNote("その他")).toContain("意味の切れ目");
  });
  it("N8 上書きの見出しで始まる（userPrompt の最後に置く）", () => {
    expect(buildSentShapeNote("短い返し").startsWith("\n\n【最後に確認：")).toBe(true);
  });
  it("★ N9 「付けろ」という命令にはしない（実測を出して選ばせる）", () => {
    for (const k of Object.keys(NANITOZO_RATE) as Array<keyof typeof NANITOZO_RATE>) {
      expect(buildSentShapeNote(k)).notToContain("必ず付ける");
    }
  });
});

describe("書く前に渡す材料（種類を当てにいかない）", () => {
  it("★ A1 場面別の率を表で渡す（モデルに選ばせる）", () => {
    const n = buildSentShapeNoteAll();
    expect(n).toContain("内覧の待ち合わせ 64.3%");
    expect(n).toContain("ピックアップの約束 22.6%");
    expect(n).toContain("物件カード 0.3%");
  });
  it("★ A2 実送信ほぼ0の場面は言い切る", () => {
    expect(buildSentShapeNoteAll()).toContain("**付けない**");
  });
  it("★ A3 改行の型を数字で渡す", () => {
    const n = buildSentShapeNoteAll();
    expect(n).toContain("17字前後");
    expect(n).toContain(String(LINE_CHARS_P90));
    expect(n).toContain("空行");
  });
  it("A4 上書きの見出しで始まる（userPrompt の最後に置く）", () => {
    expect(buildSentShapeNoteAll().startsWith("\n\n【最後に確認：")).toBe(true);
  });
});

describe("出来た文を検査する（本文は書き換えない）", () => {
  it("★ C1 内覧の待ち合わせの実物は最終行に何卒がある", () => {
    const c = checkSentShape(MEETING);
    expect(c.kind).toBe("内覧の待ち合わせ");
    expect(c.hasNanitozo).toBe(true);
    expect(c.nanitozoAtEnd).toBe(true);
  });
  it("★ C2 長すぎる行を数える（上位10%＝55字超）", () => {
    const long = "はい😊！！\n" + "あ".repeat(80);
    expect(checkSentShape(long).longLines.length).toBe(1);
    expect(checkSentShape(SHORT).longLines.length).toBe(0);
  });
  it("★ C3 何卒が途中にあると nanitozoAtEnd が false", () => {
    const mid = "かしこまりました！！\n何卒よろしくお願い致します！！\n現地エントランスお待ち合わせです！！";
    const c = checkSentShape(mid);
    expect(c.hasNanitozo).toBe(true);
    expect(c.nanitozoAtEnd).toBe(false);
  });
  it("C4 行数を数える（空行は数えない）", () => {
    expect(checkSentShape(RECEIVE).lines).toBe(3);
  });
  it("C5 空文字でも落ちない", () => {
    expect(checkSentShape("").lines).toBe(0);
    expect(checkSentShape(null).hasNanitozo).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
