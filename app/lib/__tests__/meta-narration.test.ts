// 2026-09-12 竹内（あや事例）: AI の作業メモは下書き欄に絶対に入れない
// 実行: npx tsx app/lib/__tests__/meta-narration.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { stripMetaNarration, isMetaNarrationLine } from "../meta-narration";
import { applySurfaceFixes } from "../validate-reply";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const AYA_DRAFT = "「284,500円になる感じですか？」という金額確認質問への直接回答を組み立てます。\n\nかしこまりました！！\n最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！";

it("あや: 先頭の作業メモ「〜への直接回答を組み立てます。」を消す", () => {
  const r = stripMetaNarration(AYA_DRAFT);
  expect(r.text).toBe("かしこまりました！！\n最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！");
  expect(r.removed.length).toBe(1);
});
it("過去に送られた作業メモ「シミズリルナさんへの返信案：」を消す", () => {
  expect(stripMetaNarration("シミズリルナさんへの返信案：\n\nシミズリルナさんお世話になっております！！").text).toBe("シミズリルナさんお世話になっております！！");
});
it("過去に送られた作業メモ「…親切に対応する返信を作成します。」を消す", () => {
  expect(isMetaNarrationLine("TikTokのリンク送信が続いているため、お客様の意図を確認しながら、親切に対応する返信を作成します。")).toBe(true);
});
it("見出しと本文が同じ行「修正後：〇〇さんお世話に…」→ 見出しだけ外す", () => {
  expect(stripMetaNarration("修正後：あやさんお世話になっております！！").text).toBe("あやさんお世話になっております！！");
});
it("お客様への問いかけ「「明日行けます」というお返事が、どのご質問に対するお返事なのか…」は消さない", () => {
  const t = "申し訳ございません、シミズリルナさんの「明日行けます」というお返事が、どのご質問に対するお返事なのかがちょっと理解できなくて申し訳ないです";
  expect(stripMetaNarration(t).text).toBe(t);
});
it("お客様への宣言「御見積書を作成しお送りさせて頂きます！！」は消さない", () => {
  expect(isMetaNarrationLine("最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！")).toBe(false);
});
it("「ご質問への回答をまとめさせて頂きます！！」（お客様への文）は消さない", () => {
  expect(isMetaNarrationLine("ご質問への回答をまとめさせて頂きます！！")).toBe(false);
});
it("仕上げ処理（applySurfaceFixes）でも消える", () => {
  const r = applySurfaceFixes(AYA_DRAFT, { customerName: "あや" });
  expect(r.text.startsWith("かしこまりました！！")).toBe(true);
  expect(r.applied.some((a) => a.startsWith("META_NARRATION_REMOVED"))).toBe(true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
