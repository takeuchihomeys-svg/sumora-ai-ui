// 2026-09-14 タクミ事例: 審査管理からの同期で状態を後戻りさせない（先の段階へ進める時だけ書く）
// 実行: npx tsx app/lib/__tests__/synced-status.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveSyncedStatus, resolveScreeningSync, resolveManualBackMark } from "../conversation-status";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("タクミ: 申込中（applying）を審査管理の物件提案中（property_recommendation）で戻さない", () =>
  expect(resolveSyncedStatus("applying", "property_recommendation")).toBe(null));
it("申込後の印（is_post_apply）がある会話は、状態が物件提案中でも申込より前には書かない", () =>
  expect(resolveSyncedStatus("property_recommendation", "viewing", { isPostApply: true })).toBe(null));
it("同じ段階の言い換え（proposing ↔ property_recommendation）は書かない", () =>
  expect(resolveSyncedStatus("proposing", "property_recommendation")).toBe(null));
it("先の段階へは進める（物件提案中 → 内覧）", () => expect(resolveSyncedStatus("property_recommendation", "viewing")).toBe("viewing"));
it("状態がまだ無い会話には入れる", () => expect(resolveSyncedStatus(null, "new_inquiry")).toBe("new_inquiry"));
it("成約・失注はスタッフが決める（同期で入れない・外さない）", () => {
  expect(resolveSyncedStatus("applying", "closed_lost")).toBe(null);
  expect(resolveSyncedStatus("closed_won", "property_recommendation")).toBe(null);
});
it("知らない状態名・空は書かない", () => {
  expect(resolveSyncedStatus("hearing", "unknown_status")).toBe(null);
  expect(resolveSyncedStatus("hearing", null)).toBe(null);
});

// 2026-09-15 隼斗事例: 否決で物件提案中に戻した後、審査管理の「screening」が届き続けても審査中に戻さない
const S = (cur: string | null, inc: string | null, last: string | null, isPostApply = false) => resolveScreeningSync(cur, inc, last, { isPostApply });
it("隼斗: 否決で物件提案中に戻した → 審査管理はずっと screening（前回と同じ値）→ 状態は動かさない", () => {
  const r = S("proposing", "screening", "screening");
  expect(r.status).toBe(null); expect(r.lastSeen).toBe("screening");
});
it("審査管理の状態が変わった時（新しい出来事）だけ、従来どおり先の段階へ進める", () => {
  expect(S("proposing", "applying", "property_recommendation").status).toBe("applying");
  expect(S("applying", "property_recommendation", "applying").status).toBe(null); // 後戻りはしない（タクミ）
});
it("前回の値を覚えていない会話（導入前）は今回の値を覚えるだけ（導入直後に一斉に審査中へ戻さない）", () => {
  const r = S("proposing", "screening", null);
  expect(r.status).toBe(null); expect(r.lastSeen).toBe("screening");
});
it("状態がまだ無い会話には入れる／空の値は覚えている値を保つ", () => {
  expect(S(null, "new_inquiry", null).status).toBe("new_inquiry");
  expect(S("proposing", null, "screening").lastSeen).toBe("screening");
});

// 2026-09-16 𝒮 さん事例: 手で物件提案中に戻した後、審査管理の状態が別の値に変わっても審査中に戻さない
const B = (cur: string | null, inc: string | null, last: string | null) => resolveScreeningSync(cur, inc, last, { manualBack: true });
it("𝒮: 手で戻した会話は、審査管理の状態が変わっても同期で動かさない（覚える値だけ更新）", () => {
  // 旧: 前回 screening → 今回 contract のように変われば「先へ進める」で物件提案中から審査中・契約へ動いていた
  const r = B("proposing", "contract", "screening");
  expect(r.status).toBe(null); expect(r.lastSeen).toBe("contract");
  expect(B("proposing", "screening", "property_recommendation").status).toBe(null);
});
it("印が無い会話は従来どおり（審査管理の状態が変われば先へ進める）", () =>
  expect(S("proposing", "screening", "property_recommendation").status).toBe("screening"));

it("手で戻した印は、後戻りで付けて・進める時と同じ段階で外す", () => {
  expect(resolveManualBackMark("screening", "proposing")).toBe("set");   // 𝒮 さん（審査中 → 物件提案中）
  expect(resolveManualBackMark("applying", "viewing")).toBe("set");
  expect(resolveManualBackMark("proposing", "applying")).toBe("clear");  // 手で進めた → また同期に任せる
  expect(resolveManualBackMark("proposing", "property_recommendation")).toBe("clear"); // 同じ段階の言い換え
  expect(resolveManualBackMark("screening", "closed_won")).toBe("clear");  // 終わりの状態は同期がもともと触らない
  expect(resolveManualBackMark("screening", "closed_lost")).toBe("clear");
  expect(resolveManualBackMark(null, "proposing")).toBe("clear");
  expect(resolveManualBackMark("proposing", "unknown_status")).toBe("clear"); // 知らない状態名は印を付けない
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
