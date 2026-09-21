// 「どの物件が申込ありか」を文にする（竹内 2026-09-21）。
//
// 竹内「申込ありボタンは物件毎につける。そうすれば、どの物件が申込ありなのか判断できるから」
//
// ⚠ 実送信365日で `※ 申込あり` の箇条書きは **0件**。スタッフは**名指し＋2番手の説明**で書く。
//   ★ が付いたテストはその形を守るための物（実送信の文をそのままテストに使う）。
//
// 実行: npx tsx app/lib/__tests__/application-status-note.test.ts（全 PASS で exit 0）
import { buildApplicationNote, isApplied, applicationBulletNote } from "../application-status-note";

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
    notToContain(item: unknown) { if (typeof actual === "string" && actual.includes(String(item))) throw new Error(`expected NOT to contain ${JSON.stringify(item)}`); },
  };
}
const p = (name: string, status: string) => ({ name, status });

describe("★ どの物件が申込ありか名指しする（竹内さんの指示そのもの）", () => {
  it("★ A1 3件のうち1件だけ申込あり → その物件名を出す", () => {
    const n = buildApplicationNote([
      p("Park Lane Minami 902号室", "available"),
      p("SHANNON 305号室", "unavailable"),
      p("グランコート 201号室", "available"),
    ]);
    expect(n).toContain("SHANNON 305号室");
    expect(n).toContain("2番手以降でのお申込");
    // 申込ありでない物件は出さない
    expect(n).notToContain("Park Lane Minami");
    expect(n).notToContain("グランコート");
  });
  it("★ A2 2件申込あり → 2件とも名指しする", () => {
    const n = buildApplicationNote([
      p("A 101号室", "unavailable"),
      p("B 202号室", "unavailable"),
      p("C 303号室", "available"),
    ]);
    expect(n).toContain("A 101号室");
    expect(n).toContain("B 202号室");
  });
  it("★ A3 全部申込あり → 「〇部屋とも」でまとめる（実送信の形）", () => {
    const n = buildApplicationNote([p("A 101号室", "unavailable"), p("B 202号室", "unavailable")]);
    expect(n).toContain("2部屋とも現在お申込がはいっております");
    expect(n).toContain("2番手以降でのご案内となります");
  });
  it("★ A4 1件だけの時は物件名＋2番手の説明", () => {
    const n = buildApplicationNote([p("LOHAS豊中稲津町 302号室", "unavailable")]);
    expect(n).toContain("LOHAS豊中稲津町 302号室");
    expect(n).toContain("2番手以降でのお申込みとなります");
  });
  it("★ A5 申込ありが無ければ何も出さない", () => {
    expect(buildApplicationNote([p("A 101号室", "available"), p("B 202号室", "vacating")])).toBe("");
    expect(buildApplicationNote([])).toBe("");
  });
});

describe("★ 確かめていない事実は書かない", () => {
  it("★ B1 「審査中」と書かない（申込あり＝審査中とは限らない）", () => {
    for (const props of [
      [p("A 101号室", "unavailable")],
      [p("A 101号室", "unavailable"), p("B 202号室", "available")],
      [p("A 101号室", "unavailable"), p("B 202号室", "unavailable")],
    ]) {
      expect(buildApplicationNote(props)).notToContain("審査中");
    }
  });
  it("★ B2 何番手かを断定しない（3番手・4番手と決めつけない）", () => {
    const n = buildApplicationNote([p("A 101号室", "unavailable"), p("B 202号室", "available")]);
    expect(n).notToContain("3番手");
    expect(n).notToContain("4番手");
  });
});

describe("名前が無い時", () => {
  it("★ C1 名前が空でも文は壊れない（名指しはできないので件数で言う）", () => {
    const n = buildApplicationNote([p("", "unavailable"), p("B 202号室", "available")]);
    expect(n).toContain("2番手以降でのお申込");
    expect(n).notToContain("undefined");
    if (n.trim().startsWith("は")) throw new Error("主語が空のまま「は」で始まっている");
  });
  it("C2 1件で名前が空", () => {
    const n = buildApplicationNote([p("", "unavailable")]);
    expect(n).toContain("こちらのお部屋");
    expect(n).toContain("2番手以降");
  });
});

describe("送られた件数が物件カードより多い時", () => {
  it("★ D1 total を渡せば「〇部屋とも」の数がそれに合う", () => {
    // 3部屋送られて、確認できた2部屋が両方申込あり → 「2部屋とも」ではなく一部の扱い
    const n = buildApplicationNote([p("A 101号室", "unavailable"), p("B 202号室", "unavailable")], { total: 3 });
    expect(n).notToContain("3部屋とも");
    expect(n).toContain("A 101号室");
    expect(n).toContain("B 202号室");
  });
});

describe("箇条書きの注記", () => {
  it("★ E1 実送信に無い「※ 申込あり」は使わない", () => {
    expect(applicationBulletNote("unavailable")).notToContain("※ 申込あり");
    expect(applicationBulletNote("unavailable")).toContain("お申込みが入っております");
  });
  it("E2 申込ありでなければ空", () => {
    expect(applicationBulletNote("available")).toBe("");
    expect(applicationBulletNote(null)).toBe("");
  });
  it("E3 判定", () => {
    expect(isApplied("unavailable")).toBe(true);
    expect(isApplied("available")).toBe(false);
    expect(isApplied("vacating")).toBe(false);
    expect(isApplied(undefined)).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
