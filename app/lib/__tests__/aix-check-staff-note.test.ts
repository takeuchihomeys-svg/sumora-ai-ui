// AIX【物件確認した】のスタッフ向けの注記（app/lib/aix-check-staff-note.ts）— 実物の言い方（名前なし）・LLM なし
// 実行: npx tsx app/lib/__tests__/aix-check-staff-note.test.ts
import { checkResultStaffNotes, petNoteOf, aixCheckStaffNoteEnabled } from "../aix-check-staff-note";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

console.log("aix-check-staff-note");
it("切替は既定 off", () => { eq(aixCheckStaffNoteEnabled({}), false); eq(aixCheckStaffNoteEnabled({ NEXT_PUBLIC_AIX_CHECK_STAFF_NOTE: "on" }), true); });
it("10/15 会話D: 条件「ペット2匹（小型犬）可、2人入居可能」＋発言「どうしても2匹難しいですかね？」", () => {
  eq(checkResultStaffNotes("ペット2匹（小型犬）可、2人入居可能", ["どうしても2匹難しいですかね？"]),
    ["※ 小型犬2匹の飼育可否も一緒に管理会社に確認（お客様の条件）", "※ 二人入居の可否も一緒に確認"]);
});
it("ペットの種類と数", () => {
  eq(petNoteOf(["大人2人、子供2人、犬2匹でいい物件があれば"]), "犬2匹");
  eq(petNoteOf(["猫を1匹飼っています"]), "猫");
  eq(petNoteOf(["ペット可希望"]), "ペット");
});
it("否定・関係ない文は出さない", () => {
  eq(checkResultStaffNotes("ペットなし", ["よろしくお願いします"]), []);
  eq(checkResultStaffNotes("", ["ペットは飼っていないです"]), []);
  eq(checkResultStaffNotes("1K・梅田まで20分", []), []);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
