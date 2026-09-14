// 2026-09-14 朱莉事例: こちらがまだ何も送っていない会話は、条件フォームで status が proposing に自動で上がっても初回対応（初回の挨拶を付ける）
// 実行: npx tsx app/lib/__tests__/first-reply-state.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { firstReplyStateOrNull, staffHasEngaged } from "../conversation-status";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const FORM = [{ sender: "customer", text: "▶︎【お部屋お探し中！】\n①【ご入居の時期】⇒10月中旬" }];

it("朱莉: 条件フォームで proposing に上がっても、こちらが何も送っていなければ初回対応", () => {
  expect(staffHasEngaged(FORM)).toBe(false);
  expect(firstReplyStateOrNull("proposing", staffHasEngaged(FORM))).toBe("first_reply");
});
it("hearing・first_reply・未設定も初回対応（従来どおり）", () => {
  for (const s of ["hearing", "first_reply", "condition_hearing", "", null]) expect(firstReplyStateOrNull(s, false)).toBe("first_reply");
});
it("こちらが送っていれば初回ではない（AIX の送信も数える・画像だけは数えない）", () => {
  expect(staffHasEngaged([...FORM, { sender: "staff", text: "（ご希望のお部屋探しご条件）①…" }])).toBe(true);
  expect(staffHasEngaged([...FORM, { sender: "staff", text: "[画像]" }])).toBe(false);
  expect(firstReplyStateOrNull("proposing", true)).toBe(null);
});
it("内覧以降の status は初回にしない（外で対応済みの可能性）", () => {
  for (const s of ["viewing", "applying", "screening", "contract", "closed_won"]) expect(firstReplyStateOrNull(s, false)).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
