// 2026-10-23 ブレインの弱い所の台帳（brain_weaknesses）の純関数のテスト
// 実行: npx tsx app/lib/__tests__/brain-weaknesses.test.ts（全 PASS で exit 0）
import { applyWeaknessMark, isUnmarkedWeakness, unmarkedWeaknessLine, guessWeaknessTier, withGuessedTier, SEED_WEAKNESSES, aggregateWeaknessHits, brainWeaknessLedgerEnabled, isWeaknessKey, mergeWeaknessRow, mergeEvidence, renderTouchedWeaknesses, weaknessHitsFromAixRows, weaknessHitsFromExamReasons, weaknessHitsFromUnknownAggs, weaknessKeyForUnknown } from "../brain-weaknesses";
import { upsertWeaknessHits } from "../brain-weaknesses-server";
import type { SupabaseClient } from "@supabase/supabase-js";

let fail = 0;
const ok = (c: boolean, m: string) => { if (c) console.log(`PASS ${m}`); else { fail++; console.log(`FAIL ${m}`); } };

// 2026-11-13 入る時点の印（推定）と、足す時に印・次の一手を消さない
{
  ok(guessWeaknessTier("exam-stage:writer:q024", "writer").tier === "細分化" && guessWeaknessTier("exam-stage:writer:q024", "writer").group === "G6", "試験の外れの書き手＝細分化・文の束");
  ok(guessWeaknessTier("watch-break:promise_picker", "conductor").tier === "土台", "つなぎの切れ＝土台");
  ok(guessWeaknessTier("unknown:low-confidence:fc_warn", "brain").group === "G9", "自信の低さ＝自信の束");
  ok(guessWeaknessTier("brain:something-new", "brain").tier === "要確認", "推定できない物は要確認");
  ok(guessWeaknessTier("anything", "exam").group === "G11", "area が試験なら試験の土台");
  const g = withGuessedTier({ exam_qids: ["q1"] }, "watch-break:x", "conductor");
  ok(g.tier === "土台" && g.tier_guess === true && !!g.next && g.group_parent === 25, "推定の印・次の一手・親を足す");
  const kept = withGuessedTier({ tier: "細分化", next: "手で書いた次の一手" }, "watch-break:x", "conductor");
  ok(kept.tier === "細分化" && kept.next === "手で書いた次の一手" && kept.tier_guess === undefined, "印がある行は変えない");
  const merged = mergeEvidence({ tier: "土台", next: "N", owner: "作業員1", w1_1107: "記録", exam_qids: ["q1"] }, { exam_qids: ["q2"] });
  ok(merged.tier === "土台" && merged.next === "N" && merged.owner === "作業員1" && merged.w1_1107 === "記録" && (merged.exam_qids ?? []).length === 2, "足す時に印・次の一手・作業員の書き込みを消さない（旧は消えていた）");
  const row = mergeWeaknessRow(null, { key: "exam-stage:brain:q9", title: "t", area: "brain", evidence: {} }, "2026-11-13T00:00:00Z");
  ok(row.evidence.tier === "細分化" && row.evidence.tier_guess === true, "新しい行に推定の印が付く");
}

// 2026-11-15 作業員I: 印なしの見張りと人が決めた印
{
  const now = "2026-11-15T00:00:00Z";
  const R = (key: string, status: "open" | "in_progress" | "fixed", ev: Record<string, unknown>, first: string) => ({ key, status, evidence: ev, first_seen: first });
  const rows = [
    R("brain:new-a", "open", {}, "2026-11-14T12:00:00Z"),                                              // 新しい・印なし
    R("brain:new-b", "open", { tier: "要確認", tier_guess: true }, "2026-11-14T13:00:00Z"),              // 新しい・要確認＝印なし
    R("watch-break:new-c", "open", { tier: "土台", tier_guess: true, next: "N" }, "2026-11-14T14:00:00Z"), // 新しい・推定の印だけ
    R("brain:new-d", "in_progress", { tier: "細分化" }, "2026-11-14T15:00:00Z"),                         // 新しい・次の一手が空＝印なし
    R("exam-stage:brain:q1", "open", {}, "2026-11-14T16:00:00Z"),                                      // 試験の外れは数えない
    R("brain:old", "open", {}, "2026-11-01T00:00:00Z"),                                                // 古い・印なし（全体には数える）
    R("brain:new-fixed", "fixed", {}, "2026-11-14T17:00:00Z"),                                         // 閉じた行は数えない
  ];
  const l = unmarkedWeaknessLine(rows, now);
  ok(l.startsWith("印なし 3行"), `新しく入った印なしの数（${l}）`);
  ok(l.includes("土台 1・連携 0・細分化 0") && l.includes("推定の印だけ 1行") && l.includes("全体で印なし 4行") && l.includes("brain:new-a") && !l.includes("exam-stage"), "推定だけ・全体の数・試験の外れを数えない");
  ok(unmarkedWeaknessLine([R("brain:x", "open", { tier: "土台", next: "N" }, "2026-11-14T12:00:00Z"), R("brain:old", "open", {}, "2026-11-01T00:00:00Z")], now) === "", "新しい行が全部印つきなら何も出さない（今までの出力のまま）");
  ok(unmarkedWeaknessLine(rows, now, 1) === "", "since の外は数えない");
  ok(isUnmarkedWeakness(R("k", "open", { tier: "連携", next: "N" }, now)) === false, "連携も印");
  const m = applyWeaknessMark({ tier: "要確認", tier_guess: true, exam_qids: ["q1"], w1: "記録" }, { tier: "土台", next: " 材料の帳面を作る ", cause: "材料", owner: "作業員1", by: "作業員I" }, now);
  ok(m.tier === "土台" && m.next === "材料の帳面を作る" && m.cause === "材料" && m.owner === "作業員1" && m.marked_by === "作業員I" && m.marked_at === now, "人の印・原因・持ち主を足す");
  ok(m.tier_guess === undefined && (m.exam_qids ?? []).length === 1 && m.w1 === "記録", "推定の印は外し・他の欄は残す");
  let threw = 0;
  try { applyWeaknessMark({}, { tier: "要確認", next: "N" }, now); } catch { threw++; }
  try { applyWeaknessMark({}, { tier: "土台", next: " " }, now); } catch { threw++; }
  ok(threw === 2, "要確認・空の次の一手は断る");
}

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

// 7b. 直した行に同じ key が当たった（11/06 統括役）: 同じ行に足し、open に戻して再発の印
{
  const fixedRow = { key: "exam-stage:writer:writer", title: "直した題", area: "writer" as const, symptom: null, root_cause: "r", status: "fixed" as const, fix_ref: "abc123", evidence: { exam_qids: ["q1"] }, occurrences: 3, first_seen: "2026-11-01T00:00:00Z", last_seen: "2026-11-02T00:00:00Z" };
  const re = mergeWeaknessRow(fixedRow, { key: fixedRow.key, title: "t", area: "writer", n: 2, evidence: { exam_qids: ["q2"] } }, now);
  ok(re.status === "open" && re.title === "直した題" && re.occurrences === 5 && re.fix_ref === "abc123" && (re.evidence.reopened ?? [])[0] === `${now} 直し:abc123` && (re.evidence.exam_qids ?? []).join(",") === "q2,q1", "直した行は open に戻し再発の印");
  const wf = mergeWeaknessRow({ ...fixedRow, status: "wont_fix" }, { key: fixedRow.key, title: "t", area: "writer", evidence: {} }, now);
  ok(wf.status === "wont_fix" && !wf.evidence.reopened, "見送りはそのまま");
  const again = mergeWeaknessRow(re, { key: fixedRow.key, title: "t", area: "writer", evidence: {} }, now);
  ok(again.status === "open" && (again.evidence.reopened ?? []).length === 1, "開いている行に足しても印は増えない");
  const t2 = renderTouchedWeaknesses([{ key: fixedRow.key, title: "直した題", status: "open", occurrences: 5, fix_ref: "abc123" }], { [fixedRow.key]: 2 }, new Set([fixedRow.key]));
  ok(t2.includes("⚠ [再発・open に戻した] 直した題") && t2.includes("直したのに再び 1"), "表示: 再発");
}

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
