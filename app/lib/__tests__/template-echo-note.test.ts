// フォームの貼り返し（審査面柔軟にサポート）をお客様の言葉と取り違えない（S1・2026-09-23）
// 実行: npx tsx app/lib/__tests__/template-echo-note.test.ts
import { detectTemplateEcho, buildTemplateEchoNote } from "../template-echo-note";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const falsy = (a: unknown, m = "") => { if (a) throw new Error(`expected falsy ${m}`); };

// お客様が条件フォームをテンプレートごと返してきた形（末尾がこちらの定型文）
const ECHO_FORM = "①ご希望エリア⇒平野区・東住吉区\n②ご希望家賃⇒6万まで\n③間取り⇒1K\n④入居時期⇒10月\n⑤こだわり⇒バストイレ別\n⑥駅徒歩⇒10分\n⑦初期費用の限度額⇒15万\n⑧その他⇒なし\n※審査に不安な事がある方はお気軽にご相談ください！審査面柔軟にサポートさせて頂きます！";
const ECHO_WITH_SCREENING = ECHO_FORM.replace("⑧その他⇒なし", "⑧その他⇒夜職で審査が不安です");
const PLAIN_FORM = "①ご希望エリア⇒平野区\n②ご希望家賃⇒6万まで\n③間取り⇒1K";

it("貼り返しあり・お客様は審査に触れていない → 注意の1行が出る", () => {
  const v = detectTemplateEcho(ECHO_FORM);
  truthy(v.echoed); falsy(v.customerMentionsScreening);
  truthy(buildTemplateEchoNote(ECHO_FORM).includes("お客様の言葉ではない"));
});
it("貼り返しあり・お客様自身が夜職/審査を書いた → 出さない（実送信で審査に触れた2件はこの形）", () => {
  const v = detectTemplateEcho(ECHO_WITH_SCREENING);
  truthy(v.echoed); truthy(v.customerMentionsScreening);
  falsy(buildTemplateEchoNote(ECHO_WITH_SCREENING));
});
it("貼り返しなし → 出さない", () => {
  falsy(detectTemplateEcho(PLAIN_FORM).echoed);
  falsy(buildTemplateEchoNote(PLAIN_FORM));
});
it("空・null は落ちない", () => { falsy(buildTemplateEchoNote("")); falsy(buildTemplateEchoNote(null)); });
it("2回続けて呼んでも同じ結果（g フラグの lastIndex を持ち越さない）", () => {
  truthy(detectTemplateEcho(ECHO_FORM).echoed);
  truthy(detectTemplateEcho(ECHO_FORM).echoed);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
