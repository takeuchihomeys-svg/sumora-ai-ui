// 漢字とひらがなの混ぜ方を実送信に合わせる（竹内 2026-09-21）。
//
// 竹内「実際のスタッフが送るような文が生成されていない可能性があるってこと？」
// → 下書きと実送信の差分で、消される1位「内させて頂きます」201回・足される1位「せていただきます」262回
//   ＝ 同じ意味で表記だけ違った。
//
// 実行: npx tsx app/lib/__tests__/notation-mix.test.ts（全 PASS で exit 0）
import { notationGaps, checkNotationMix, NOTATION_GAP_PT } from "../notation-mix";
import { buildWaitedNote, buildWaitedOpeningChoice, isWaitedAllowed, waitedSentRate, waitedUsedLastTime, WAITED_SENT_RATE, WAITED_NOTE_MIN_PCT } from "../waited-scope";

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

describe("表記のずれ（監査の表示用・生成には渡さない）", () => {
  it("★ N1 ずれの大きい組を拾う（させて頂く +25.1pt・致します +17.7pt・いつでも -15.7pt）", () => {
    const names = notationGaps().map((p) => p.name);
    expect(names.includes("させて頂く／させていただく")).toBe(true);
    expect(names.includes("致します／いたします")).toBe(true);
    expect(names.includes("何時でも／いつでも")).toBe(true);
  });
  it("N2 線は10pt（小さいずれは拾わない）", () => {
    expect(NOTATION_GAP_PT).toBe(10);
    for (const p of notationGaps()) {
      if (Math.abs(p.sentKanaPct - p.draftKanaPct) < 10) throw new Error(`${p.name} を拾っている`);
    }
  });
  it("★ N3 生成に渡す関数を作らない（2026-09-21 監査で止めた）", () => {
    // 1通に1回しか出ない・会話に合わせても当たらない・AI の選択は既に多数派、の3点で配線しないと決めた。
    // 将来また材料にしたくなった時は scripts/audit-notation-signal.ts を回してから。
    const mod = require("../notation-mix") as Record<string, unknown>;
    if (typeof mod.buildNotationNote === "function") {
      throw new Error("buildNotationNote が復活している。notation-mix.ts のヘッダ「監査で止めた」を読むこと");
    }
  });
});

describe("出来た文の表記を数える（本文は書き換えない）", () => {
  it("★ C1 漢字とひらがなを数える", () => {
    const r = checkNotationMix("ピックアップさせて頂きます！！\nお送りさせていただきます！！");
    const p = r.find((x) => x.name.startsWith("させて頂く"));
    if (!p) throw new Error("組が見つからない");
    expect(p.kanji).toBe(1);
    expect(p.kana).toBe(1);
    expect(Math.round(p.kanaPct)).toBe(50);
  });
  it("★ C2 全部漢字なら実送信とのずれが大きく出る", () => {
    const r = checkNotationMix("探させて頂きます！！\nお送りさせて頂きます！！\nご案内させて頂きます！！");
    const p = r.find((x) => x.name.startsWith("させて頂く"));
    if (!p) throw new Error("組が見つからない");
    expect(p.kanaPct).toBe(0);
    expect(Math.round(p.gapPt)).toBe(-32);   // 実送信32.5% に対して 0%（-32.5 → 四捨五入で -32）
  });
  it("C3 その語が無ければ返さない", () => {
    expect(checkNotationMix("はい😊！！").length).toBe(0);
  });
  it("C4 空でも落ちない", () => {
    expect(checkNotationMix("").length).toBe(0);
    expect(checkNotationMix(null).length).toBe(0);
  });
  it("★ C5 正規表現は監査と同じ数を数える（四者同名）", () => {
    // 「させて頂き」は「して頂き」にも一致しうるので、組み分けが崩れていないか
    const r = checkNotationMix("確認させて頂きます");
    expect(r.length).toBe(1);
    expect(r[0].name.startsWith("させて頂く")).toBe(true);
  });
});

// ⚠ 2026-09-27 竹内さん決定で上書き: AIX でも「お待たせ致しました」は使わない（waited-scope の許す一覧は空）。
//   9/21 の「許す場面では率を材料にする」「挨拶行の2択」の試験は、全部「出ない」ことを確かめる形に置き換えた
//   （経緯は waited-scope.ts のコメント・出口の試験は waited-scope.test.ts）。
describe("お待たせ致しました — 2026-09-27 から AIX でも材料・2択を出さない", () => {
  it("★ W1 率の材料は全場面で空", () => {
    for (const a of Object.keys(WAITED_SENT_RATE)) {
      expect(buildWaitedNote(a)).toBe("");
      expect(waitedSentRate(a)).toBe(null);
      expect(isWaitedAllowed(a)).toBe(false);
    }
    expect(WAITED_NOTE_MIN_PCT).toBe(10);
  });
  it("★ O1 2択は全場面で空（呼び出し側は従来の固定の挨拶に戻る）", () => {
    for (const a of ["property_send", "estimate_sheet", "property_check_result_unavailable", "zenryoku_support"]) {
      expect(buildWaitedOpeningChoice(a, "お世話になっております！！", true)).toBe("");
      expect(buildWaitedOpeningChoice(a, "", false)).toBe("");
    }
  });
  it("O11 前回の判定（監査用）は冒頭だけ見る・画像は飛ばす", () => {
    expect(waitedUsedLastTime(["YUMAさんお待たせ致しました！！\n物件です"])).toBe(true);
    expect(waitedUsedLastTime(["内覧のご案内です！！\n現地でお待たせしましたら申し訳御座いません"])).toBe(false);
    expect(waitedUsedLastTime(["YUMAさんお待たせ致しました！！", "[画像]"])).toBe(true);
    expect(waitedUsedLastTime([])).toBe(null);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
