// 2026-09-11 統合設計 §7: 生成失敗文・テスト送信を正解例・学習材料・送信に使わない（example-hygiene.ts）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/hygiene.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import * as fs from "fs";
import * as path from "path";
import { GENERATION_FAILURE_TEXT, isUsableExampleText, isUsableAiDraft, isGenerationFailureText } from "../example-hygiene";

// ── ミニハーネス ──
let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");

describe("正解例として使えるか", () => {
  it("H1 生成失敗文・「あ」「ああ」・空文は isUsableExampleText=false", () => {
    for (const s of [GENERATION_FAILURE_TEXT, "（AI返信の生成に失敗しました。再生成をお試しください）", "あ", "ああ", "", "   "]) expect(isUsableExampleText(s)).toBe(false);
  });
  it("H2 通常のスタッフ送信は true（短い正解「はい😊！！」も残す）", () => {
    for (const s of ["はい😊！！", "かしこまりました！！\n募集状況確認させて頂きます！！"]) expect(isUsableExampleText(s)).toBe(true);
  });
  it("H3 失敗文の下書きは差分学習に使わない（isUsableAiDraft=false）", () => {
    expect(isUsableAiDraft(GENERATION_FAILURE_TEXT)).toBe(false);
    expect(isUsableAiDraft("かしこまりました！！")).toBe(true);
  });
});

describe("書く側で止める（送信・保存）", () => {
  it("S1 send-line-message は失敗文を 400 で止める（同じ判定関数を import している）", () => {
    const s = src("api/send-line-message/route.ts");
    expect(/isGenerationFailureText\(message\)/.test(s) && /status: 400/.test(s)).toBe(true);
    expect(isGenerationFailureText(`${GENERATION_FAILURE_TEXT}`)).toBe(true);
  });
  it("S2 generate-reply の例外時の文言は定数1か所（GENERATION_FAILURE_TEXT）", () => {
    const s = src("api/generate-reply/route.ts");
    expect(s.includes("encoder.encode(GENERATION_FAILURE_TEXT)")).toBe(true);
    expect(s.includes("encoder.encode(\"（AI返信の生成に失敗しました")).toBe(false);
  });
  it("S3 save-reply-example は失敗文の送信文を保存しない", () => {
    const s = src("api/save-reply-example/route.ts");
    expect(/isGenerationFailureText\(sentReply\)/.test(s)).toBe(true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
