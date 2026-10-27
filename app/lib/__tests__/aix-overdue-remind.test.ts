// 24時間を過ぎた AIX要対応の知らせ直し（2026-10-28 竹内さんの決定）。名前は作り物
// 実行: npx tsx app/lib/__tests__/aix-overdue-remind.test.ts
import { aixOverdueRemindEnabled, overdueAixItems, buildAixOverdueRemind, overdueRemindDue } from "../aix-overdue-remind";
import type { AixActionItemRow } from "../aix-action-text";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const H = 3600_000;
const NOW = Date.parse("2026-10-28T02:00:00Z"); // JST 11:00
const row = (id: string, ageH: number, o: Partial<AixActionItemRow> = {}): AixActionItemRow => ({ id, conversation_id: "c", customer_name: "山田", action: "viewing_invite", check_pattern: null, status: "pending", done_aix_type: null, done_at: null, created_at: new Date(NOW - ageH * H).toISOString(), ...o });

it("既定 off・on で入る", () => { eq(aixOverdueRemindEnabled({}), false); eq(aixOverdueRemindEnabled({ AIX_OVERDUE_REMIND: "on" }), true); });
it("24〜48時間の未対応だけ・古い順（24時間未満・48時間超・済み・取り下げは入れない）", () => {
  const items = [row("a", 30), row("b", 25), row("c", 10), row("d", 50), row("e", 30, { status: "done" }), row("f", 30, { status: "dismissed" })];
  eq(overdueAixItems(items, NOW).map((i) => i.id), ["a", "b"]);
});
it("文はグループの形（〇〇さん → AIX【ボタン】）・時間つき・無ければ送らない", () => {
  const t = buildAixOverdueRemind([row("a", 30, { action: "property_check_result", check_pattern: "mgmt_parking" })], NOW) ?? "";
  ok(/【AIX要対応・24時間を過ぎています】/.test(t), t);
  ok(/・山田さん → AIX【確認した（条件・交渉）→駐車場】（30時間）/.test(t), t);
  eq(buildAixOverdueRemind([row("c", 10)], NOW), null);
});
it("1日1回: 今日まだ送っていない時だけ", () => {
  eq(overdueRemindDue(null, NOW), true);
  eq(overdueRemindDue(new Date(NOW - 26 * H).toISOString(), NOW), true);
  eq(overdueRemindDue(new Date(NOW - 1 * H).toISOString(), NOW), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
