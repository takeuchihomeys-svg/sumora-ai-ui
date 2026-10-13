// 出口ごとの変化の記録（app/lib/exit-edits.ts）と tpo_debug の補い（app/lib/tpo-debug-fallback.ts）のテスト
// 実行: npx tsx app/lib/__tests__/exit-edits.test.ts
import { createHash } from "node:crypto";
import { createExitRecorder, diffExitSentences, splitExitSentences } from "../exit-edits";
import { pickServerTpoDebug } from "../tpo-debug-fallback";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m} ${x} !== ${y}`); }
const sha1 = (t: string) => createHash("sha1").update(t, "utf8").digest("hex");

console.log("exit-edits");
it("文に分ける（！！は1文・改行）", () => {
  eq(splitExitSentences("かしこまりました😊！！\n御見積書作成しお送りさせて頂きます！！何卒"), ["かしこまりました😊！！", "御見積書作成しお送りさせて頂きます！！", "何卒"]);
});
it("消えた文と足された文（多重集合）", () => {
  const d = diffExitSentences("A！！\nB！！\nA！！", "A！！\nC！！");
  eq(d.removed, ["B！！", "A！！"]); eq(d.added, ["C！！"]);
});
it("変わらない・空白だけの変化は積まない", () => {
  const r = createExitRecorder(true);
  r.record(1, "x", "A！！", "A！！");
  r.record(1, "tidy", "A！！  \nB", "A！！\nB");
  eq(r.edits.length, 0);
});
it("変化を積み after を返す・理由を付ける", () => {
  const r = createExitRecorder(true);
  const out = r.record(2, "guardPropertyNames", "ルミエール梅田のご内覧承知しました！！", "ご内覧承知しました！！", ["ルミエール梅田"]);
  eq(out, "ご内覧承知しました！！");
  eq(r.edits, [{ gen: 2, exit: "guardPropertyNames", removed: ["ルミエール梅田のご内覧承知しました！！"], added: ["ご内覧承知しました！！"], why: ["ルミエール梅田"] }]);
});
it("止めている時は積まない（after は返す）", () => {
  const r = createExitRecorder(false);
  eq(r.record(1, "x", "A", "B"), "B"); eq(r.edits.length, 0);
});

console.log("tpo-debug-fallback");
const tpo = { tier: "T1" };
it("下書きの hash が同じなら使う", () => {
  eq(pickServerTpoDebug({ tpo_debug: tpo, checked_text_hash: sha1("下書き") }, { aiDraft: " 下書き\n" })?.by, "draft_hash");
});
it("お客様の発言の hash が同じなら使う（連投の最後の1通も）", () => {
  eq(pickServerTpoDebug({ tpo_debug: tpo, context_hash: sha1("A\n⁣\nB") }, { customerMessage: "A\n⁣\nB" })?.by, "context_hash");
  eq(pickServerTpoDebug({ tpo_debug: tpo, context_hash: sha1("A\n⁣\nB"), context_last_hash: sha1("B") }, { customerMessage: "B" })?.by, "context_hash");
});
it("別の番・初回連絡・tpo なしは使わない", () => {
  eq(pickServerTpoDebug({ tpo_debug: tpo, context_hash: sha1("A") }, { customerMessage: "B", aiDraft: "x" }), null);
  eq(pickServerTpoDebug({ tpo_debug: tpo, context_hash: sha1("（初回連絡）") }, { customerMessage: "（初回連絡）" }), null);
  eq(pickServerTpoDebug({ checked_text_hash: sha1("x") }, { aiDraft: "x" }), null);
  eq(pickServerTpoDebug(null, { aiDraft: "x" }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
