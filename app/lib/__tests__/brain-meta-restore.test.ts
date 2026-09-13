// 2026-09-13 監査 抜け1: 下書きを表示した後の生成（再生成・✨・AIX 文面）にブレインの判断を届ける（表示で消えただけの判断を控えから戻す）
// 実行: npx tsx app/lib/__tests__/brain-meta-restore.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { restoreMetaAfterShown, brainMissedCustomerMessage, BRAIN_FRESHNESS_TOLERANCE_MS } from "../brain-meta-restore";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const SKIP = ["contract", "closed_won", "closed_lost", "lost", "approved"];
const CUST_AT = "2026-09-12T07:10:00.000Z";
const last = { action: "property_check_result", source: "brain_incremental", analyzed_msg_ts: CUST_AT, customer_questions: ["3階は空いてますか"] };
const base = { suggestedAixMeta: null, lastBrainMeta: last, aiDraft: "__SHOWN__", status: "viewing", latestCustomerMsgAt: CUST_AT, skipStatuses: SKIP };

it("f568a14b 型: 表示で消えた・控えが最新の発言を見た本分析 → 戻す", () => {
  const r = restoreMetaAfterShown(base);
  expect(r.restored).toBe(true);
  expect(r.meta?.action).toBe("property_check_result");
});
it("suggested_aix_meta があればそのまま（戻さない）", () => {
  const r = restoreMetaAfterShown({ ...base, suggestedAixMeta: { action: "estimate_sheet", source: "brain" } });
  expect(r.restored).toBe(false);
  expect(r.meta?.action).toBe("estimate_sheet");
  expect(r.reason).toBe("has_meta");
});
it("スタッフの送信で消えた（ai_draft=null）→ 戻さない", () => expect(restoreMetaAfterShown({ ...base, aiDraft: null }).reason).toBe("not_shown"));
it("下書き本文がある（未表示）→ 戻さない", () => expect(restoreMetaAfterShown({ ...base, aiDraft: "お世話になっております！！" }).reason).toBe("not_shown"));
it("表示後にお客様の新着（控えは新着を見ていない）→ 戻さない", () => {
  const r = restoreMetaAfterShown({ ...base, latestCustomerMsgAt: new Date(Date.parse(CUST_AT) + BRAIN_FRESHNESS_TOLERANCE_MS + 1000).toISOString() });
  expect(r.restored).toBe(false);
  expect(r.reason).toBe("stale");
});
it("同じ秒の丸め（5秒以内）は同じ発言を見たとみなす", () => {
  expect(restoreMetaAfterShown({ ...base, latestCustomerMsgAt: new Date(Date.parse(CUST_AT) + 3000).toISOString() }).restored).toBe(true);
});
it("AIX 送信後の書き換え（aix_patch）は戻さない", () => expect(restoreMetaAfterShown({ ...base, lastBrainMeta: { ...last, source: "aix_patch" } }).reason).toBe("not_restorable_source"));
it("分析の省略（cached）は戻さない", () => expect(restoreMetaAfterShown({ ...base, lastBrainMeta: { ...last, source: "cached" } }).reason).toBe("not_restorable_source"));
it("成約済み（closed_won）は戻さない", () => expect(restoreMetaAfterShown({ ...base, status: "closed_won" }).reason).toBe("skip_status"));
it("控えに analyzed_msg_ts が無い → 戻さない", () => expect(restoreMetaAfterShown({ ...base, lastBrainMeta: { action: "x", source: "brain" } }).reason).toBe("no_ts"));
it("最新のお客様発言が分からない → 戻さない（鮮度を確かめられない）", () => expect(restoreMetaAfterShown({ ...base, latestCustomerMsgAt: null }).reason).toBe("no_customer_msg"));
it("控えが無い → null", () => expect(restoreMetaAfterShown({ ...base, lastBrainMeta: null }).meta).toBe(null));

// 2026-09-13 名無しの権兵衛事例: 1通目だけを見た判断のまま、1分後の2通目を見たブレインが動かなかった（bg-async の取りこぼし救済）
it("判断が1通目（01:37）だけを見ていて2通目（01:38）がある → 見ていない発言あり", () =>
  expect(brainMissedCustomerMessage("2026-09-12T16:38:03Z", ["2026-09-12T16:37:10Z", null])).toBe(true));
it("判断が最新の発言を見ている（同じ秒の丸め5秒以内も含む）→ なし", () => {
  expect(brainMissedCustomerMessage("2026-09-12T16:38:03Z", ["2026-09-12T16:38:03Z"])).toBe(false);
  expect(brainMissedCustomerMessage("2026-09-12T16:38:03Z", [null, "2026-09-12T16:38:00Z"])).toBe(false);
});
it("表示で消えた判断（suggested_aix_meta なし）でも控え（last_brain_meta）が見ていれば なし・どちらも無ければ あり", () => {
  expect(brainMissedCustomerMessage("2026-09-12T16:38:03Z", [null, "2026-09-12T16:38:03Z"])).toBe(false);
  expect(brainMissedCustomerMessage("2026-09-12T16:38:03Z", [null, null])).toBe(true);
});
it("お客様の発言が無い → なし", () => expect(brainMissedCustomerMessage(null, [null])).toBe(false));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
