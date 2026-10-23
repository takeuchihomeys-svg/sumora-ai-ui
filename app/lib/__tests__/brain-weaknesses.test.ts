// 2026-10-23 ブレインの弱い所の台帳（brain_weaknesses）の純関数のテスト
// 実行: npx tsx app/lib/__tests__/brain-weaknesses.test.ts（全 PASS で exit 0）
import { SEED_WEAKNESSES, aggregateWeaknessHits, brainWeaknessLedgerEnabled, isWeaknessKey, mergeWeaknessRow, mergeEvidence, renderTouchedWeaknesses, weaknessHitsFromAixRows, weaknessHitsFromExamReasons, weaknessHitsFromUnknownAggs, weaknessKeyForUnknown } from "../brain-weaknesses";
import { upsertWeaknessHits } from "../brain-weaknesses-server";
import type { SupabaseClient } from "@supabase/supabase-js";

let fail = 0;
const ok = (c: boolean, m: string) => { if (c) console.log(`PASS ${m}`); else { fail++; console.log(`FAIL ${m}`); } };

// 1. 種: 21個・鍵は一意で形が正しい・状態がそろっている
ok(SEED_WEAKNESSES.length === 21, "種は21個");
ok(new Set(SEED_WEAKNESSES.map((s) => s.key)).size === 21, "種の鍵は一意");
ok(SEED_WEAKNESSES.every((s) => isWeaknessKey(s.key)), "種の鍵の形");
ok(SEED_WEAKNESSES.filter((s) => s.status === "fixed").length === 10 && SEED_WEAKNESSES.filter((s) => s.status === "open").length === 3, "直した10・未着手3");

// 2. 切替
ok(brainWeaknessLedgerEnabled({}) && !brainWeaknessLedgerEnabled({ BRAIN_WEAKNESS_LEDGER: "off" }) && !brainWeaknessLedgerEnabled({ BRAIN_WEAKNESS_LEDGER: " OFF " }), "既定 on・off で止まる");

// 3. 試験の外れの理由 → 弱い所（evidence の文は入れない）
const ex = weaknessHitsFromExamReasons("fix1", [{ id: "q001", kind: "道の取り違え", evidence: "お客様の文 山田さん" } as { id: string; kind: string }, { id: "q002", kind: "道の取り違え" }, { id: "q003", kind: "謎の型" }]);
const exAgg = aggregateWeaknessHits(ex);
ok(exAgg[0].key === "w01-owner-decisions-not-in-prod" && exAgg[0].n === 2, "同じ型は1つにまとめて数える");
ok(JSON.stringify(exAgg[0].evidence) === JSON.stringify({ exam_qids: ["q001", "q002"], exam_labels: ["fix1"] }), "印は問題 id と回だけ");
ok(!JSON.stringify(ex).includes("山田"), "読み手の evidence の文を入れない");
ok(exAgg.some((a) => a.key === "exam-miss:other"), "知らない型は exam-miss:other");

// 4. AIX の文: 種類だけ（値は入れない）
const ax = weaknessHitsFromAixRows("aix-text:fix1", [
  { id: "a1", score: { pass: false, missing: ["号室:102"], fabricated: ["家賃:50000"], staffOnly: [] } },
  { id: "a2", score: { pass: true, missing: [], fabricated: [], staffOnly: [] } },
  { id: "a3", score: { pass: false, missing: [], fabricated: [], staffOnly: [] } },
  { id: "a4", score: null, err: "ERR" },
]);
ok(ax.map((h) => h.key).join(",") === "w11-aix-text-key-line-missing,aix-text:fabricated,aix-text:low-score", "抜け・作り事・形だけ／合格と ERR は数えない");
ok(!JSON.stringify(ax).includes("102") && !JSON.stringify(ax).includes("50000"), "値を入れない");

// 5. 分からない事 → 弱い所（決まった計算）
ok(weaknessKeyForUnknown("watch_break", "promise_picker:missing")?.key === "watch-break:promise_picker", "つなぎの切れはつなぎごと");
ok(weaknessKeyForUnknown("exam_miss_type", "道の取り違え") === null, "試験の型は寄せない（試験の道で入れる）");
const uh = weaknessHitsFromUnknownAggs([
  { kind: "low_confidence_reason", key: "company_fact", label: "会社の事実に反する言い切り", n: 3, refs: [{ turn_id: 11 }, { turn_id: 12 }], lastAt: "2026-10-22T10:00:00Z" },
  { kind: "watch_break", key: "brain_second:dropped", label: "④ブレイン→2通目：落ちた", n: 2, refs: [{}] },
  { kind: "exam_miss_type", key: "x", n: 1 },
], (k, key) => (k === "low_confidence_reason" && key === "company_fact" ? 77 : undefined));
ok(uh.length === 2 && uh[0].key === "unknown:low-confidence:company_fact" && uh[0].n === 3, "自信の理由の鍵と数");
ok(JSON.stringify(uh[0].evidence) === JSON.stringify({ watch_turn_ids: [11, 12], unknown_ids: [77] }), "印は番 id と分からない事の id");
ok(uh[1].title === "つなぎの切れ（④ブレイン→2通目）", "題はつなぎの名前だけ");

// 6. 足し合わせ: 状態・題は人の物を残す・数は足す・印は20まで
const now = "2026-10-23T00:00:00Z";
const ex1 = mergeWeaknessRow({ key: "w01-owner-decisions-not-in-prod", title: "人が付けた題", area: "brain", symptom: null, root_cause: "x", status: "in_progress", fix_ref: "feat/x", evidence: { exam_qids: ["q9"] }, occurrences: 4, first_seen: "2026-10-01T00:00:00Z", last_seen: "2026-10-30T00:00:00Z" }, exAgg[0], now);
ok(ex1.title === "人が付けた題" && ex1.status === "in_progress" && ex1.occurrences === 6, "状態・題を残し数を足す");
ok(ex1.last_seen === "2026-10-30T00:00:00Z" && ex1.first_seen === "2026-10-01T00:00:00Z", "最初・最後は広い方");
ok(JSON.stringify(ex1.evidence.exam_qids) === JSON.stringify(["q001", "q002", "q9"]), "新しい印を前に");
const fresh = mergeWeaknessRow(null, { key: "aix-text:fabricated", title: "t", area: "aix", n: 2, evidence: { exam_qids: ["a1"] } }, now);
ok(fresh.status === "open" && fresh.occurrences === 2 && fresh.first_seen === now, "新しい鍵は open");
ok((mergeEvidence({ exam_qids: Array.from({ length: 30 }, (_, i) => `o${i}`) }, { exam_qids: ["n1"] }).exam_qids ?? []).length === 20, "印は20まで");

// 7. 表示: 開いている物と直したのに再び
const txt = renderTouchedWeaknesses([
  { key: "a", title: "開いてる", status: "open", occurrences: 5, fix_ref: null },
  { key: "b", title: "直した物", status: "fixed", occurrences: 2, fix_ref: "abc123" },
  { key: "c", title: "触ってない", status: "open", occurrences: 9, fix_ref: null },
], { a: 2, b: 1 });
ok(txt.includes("開いてる: この回 2") && txt.includes("⚠ [直した] 直した物") && !txt.includes("触ってない"), "この回で触った物だけ出す");

// 8. サーバー: 切替 off は書かない・同じ回は二重に足さない
(async () => {
  let wrote = 0;
  const fake = (existing: unknown[]) => ({ from: () => ({ select: () => ({ in: async () => ({ data: existing, error: null }) }), upsert: (rows: unknown[]) => { wrote += rows.length; return { select: async () => ({ data: rows, error: null }) }; } }) }) as unknown as SupabaseClient;
  const r0 = await upsertWeaknessHits(fake([]), ex, { env: { BRAIN_WEAKNESS_LEDGER: "off" } });
  ok(r0.rows === 0 && wrote === 0 && !!r0.skipped, "off は書かない");
  const r1 = await upsertWeaknessHits(fake([]), ex, { env: {}, onceLabel: "fix1" });
  ok(r1.rows === 2 && wrote === 2 && r1.nThisRun["w01-owner-decisions-not-in-prod"] === 2, "新しい鍵を書く");
  const had = [{ key: "w01-owner-decisions-not-in-prod", title: "t", area: "brain", status: "open", evidence: { exam_labels: ["fix1"] }, occurrences: 2 }, { key: "exam-miss:other", title: "t", area: "exam", status: "open", evidence: { exam_labels: ["fix1"] }, occurrences: 1 }];
  const r2 = await upsertWeaknessHits(fake(had), ex, { env: {}, onceLabel: "fix1" });
  ok(r2.rows === 0 && wrote === 2 && !!r2.skipped, "同じ回は二重に足さない");
  console.log(fail ? `\n${fail} FAIL` : "\nALL PASS");
  process.exit(fail ? 1 : 0);
})();
