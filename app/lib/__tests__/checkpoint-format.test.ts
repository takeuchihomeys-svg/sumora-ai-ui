// 2026-09-13: 会話のセーブデータ（checkpoint）の出力の読み取り — 途中で切れた出力は保存しない・軽い崩れは直して読む
// 実行: npx tsx app/lib/__tests__/checkpoint-format.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { parseCheckpointOutput, escapeControlCharsInStrings, clipSummary, CHECKPOINT_FACTS_MAX } from "../checkpoint-format";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const GOOD = `{"summary":"【確認済み事実】家賃: 6〜7万（9/6顧客）\\n【物件】LIVIAZ NAMBA KRASS 1201号室: 初期費用199,500円（24,000円割引・9/12 AIX見積）・ペット敷金1ヶ月","key_facts":[{"type":"confirmed_fact","value":"LIVIAZ NAMBA KRASS 1201号室 初期費用199,500円（9/12見積）"}],"stage":"proposing"}`;

it("正しい出力はそのまま読む", () => {
  const r = parseCheckpointOutput(GOOD, "end_turn");
  expect(r.ok).toBe(true);
  if (r.ok) { expect(r.value.stage).toBe("proposing"); expect(r.value.key_facts.length).toBe(1); expect(r.repaired).toBe(false); }
});
it("本番の失敗: 出力が途中で切れた（stop_reason=max_tokens）→ 保存しない", () => {
  const cut = GOOD.slice(0, 180) + '"},{"type":"confirmed_fact","value":"途中';
  const r = parseCheckpointOutput(cut, "max_tokens");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("truncated");
});
it("途中で切れて最後の } が key_facts の中にある形（旧コードで Expected ',' or ']' になった形）→ 読めないので保存しない", () => {
  const cut = `{"summary":"【確認済み事実】家賃6万","key_facts":[{"type":"confirmed_fact","value":"a"},{"type":"confirmed_fact","value":"b"}`;
  const r = parseCheckpointOutput(cut, "end_turn");
  expect(r.ok).toBe(false);
});
it("文字列の中の生の改行（Bad control character）→ 直して読む", () => {
  const raw = `{"summary":"【確認済み事実】家賃6万\n【未解決事項】なし","key_facts":[],"stage":"hearing"}`;
  const r = parseCheckpointOutput(raw, "end_turn");
  expect(r.ok).toBe(true);
  if (r.ok) { expect(r.repaired).toBe(true); expect(r.value.summary).toBe("【確認済み事実】家賃6万\n【未解決事項】なし"); }
});
it("コードブロックで囲まれていても読む", () => {
  expect(parseCheckpointOutput("```json\n" + GOOD + "\n```", "end_turn").ok).toBe(true);
});
it("summary が空 → 保存しない", () => {
  const r = parseCheckpointOutput(`{"summary":"  ","key_facts":[]}`, "end_turn");
  expect(r.ok).toBe(false);
});
it("key_facts は種類の決まった物だけ・最大10件・各80字まで", () => {
  const facts = Array.from({ length: 15 }, (_, i) => ({ type: i === 0 ? "bogus" : "confirmed_fact", value: "あ".repeat(100) }));
  const r = parseCheckpointOutput(JSON.stringify({ summary: "x", key_facts: facts, stage: "viewing" }), "end_turn");
  expect(r.ok).toBe(true);
  if (r.ok) { expect(r.value.key_facts.length).toBe(CHECKPOINT_FACTS_MAX); expect(r.value.key_facts[0].value.length).toBe(80); expect(r.value.stage).toBe(null); }
});
it("エスケープ済みの \\\" や \\n は壊さない", () => {
  const s = `{"summary":"a\\"b\\nc"}`;
  expect(escapeControlCharsInStrings(s)).toBe(s);
});
it("長すぎる summary は行の途中で切らない", () => {
  const long = Array.from({ length: 40 }, (_, i) => `行${i}: ${"事実".repeat(30)}`).join("\n");
  const c = clipSummary(long, 500);
  expect(c.length <= 500).toBe(true);
  expect(c.split("\n").every((l) => /^行\d+: (事実)+$/.test(l))).toBe(true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
