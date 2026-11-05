// 実行: npx tsx app/lib/__tests__/conductor-replan.test.ts
import { conductorReplanOn, replanCandidate, planIsStale, replanDigest } from "../conductor-replan";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

it("既定 off", () => { ok(!conductorReplanOn({})); ok(conductorReplanOn({ CONDUCTOR_REPLAN: "on" })); });
it("スタンプ・お礼・了承だけ → keep", () => {
  eq(replanCandidate({ newTexts: ["[スタンプ]"] }).kind, "keep");
  eq(replanCandidate({ newTexts: ["ありがとうございます😊"] }).kind, "keep");
  eq(replanCandidate({ newTexts: ["了解です！", "よろしくお願いします🙇‍♀️"] }).kind, "keep");
});
it("KB 2d0f33cf: keep でも前の判断の AIX（ピックアップの約束の後 → 物件を送る）は残す", () => {
  const r = replanCandidate({ newTexts: ["ありがとうございます！"], prevAix: "property_send" });
  eq(r.kind, "keep"); eq(r.keepAix, "property_send");
});
it("質問・依頼・取り消し・条件・持ち込み → reread", () => {
  for (const t of ["駐車場ありますか？", "やっぱり別の物件で", "予算を8万にしてほしいです", "https://suumo.jp/x", "[画像]", "内見いつできますか", "キャンセルでお願いします"]) eq(replanCandidate({ newTexts: ["ありがとうございます", t] }).kind, "reread");
});
it("短くないお礼・読まないと分からない通 → reread", () => {
  eq(replanCandidate({ newTexts: ["ありがとうございます！とても良さそうなので彼氏と相談してみてまた連絡しますね"] }).kind, "reread");
  eq(replanCandidate({ newTexts: ["あ"] }).kind, "reread");
});
it("計画の見た時刻: 新しいお客様の発言があれば stale", () => {
  ok(planIsStale("2026-11-05T10:00:00Z", "2026-11-05T10:01:00Z")); ok(!planIsStale("2026-11-05T10:01:00Z", "2026-11-05T10:01:00Z"));
  ok(planIsStale(null, "2026-11-05T10:01:00Z")); ok(!planIsStale(null, null));
});
it("digest", () => {
  eq(replanDigest({ kind: "keep", why: "スタンプ" }), "keep:スタンプ"); eq(replanDigest({ kind: "replan", from: "answer", to: "promise_keep" }), "replan:answer→promise_keep"); eq(replanDigest({ kind: "t2" }), "t2");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
