// 2026-10-23 試験の節約できる案の台帳（exam_savings）の純関数のテスト
// 実行: npx tsx app/lib/__tests__/exam-savings.test.ts（全 PASS で exit 0）
import {
  SEED_SAVINGS, SAFE_ACTIONS, aggregateSavingHits, applyAutoToEnv, costPerRepByLabel, detectBaselineWaste, detectCacheMiss, detectDuplicateRuns, detectFlashEligible, detectOverlongOutput,
  detectPeak, detectRepsOverkill, externalFixNotes, detectSavings, detectSwitchesOff, isSavingKey, mergeSavingRow, ownerQuestionFor, perDayOf, planAutoApply, renderRunSavings, renderTopSavings,
  type LedgerLite, type UsageRowLite,
} from "../exam-savings";
import { sameAnswers } from "../../../scripts/lib/exam-savings-io";

let fail = 0;
const ok = (c: boolean, m: string) => { if (c) console.log(`PASS ${m}`); else { fail++; console.log(`FAIL ${m}`); } };
const U = (o: Partial<UsageRowLite>): UsageRowLite => ({ route: "script:brain-exam-a1", action: "brain_fresh", model: "deepseek-v4-pro", created_at: "2026-10-23T12:00:00Z", input_uncached: 1000, cache_read: 30000, output_tokens: 200, usd: 0.01, ...o });
const L = (o: Partial<LedgerLite>): LedgerLite => ({ at: "2026-10-23T12:00:00Z", label: "a1", id: "q1", type: "初回", stage: "brain", model: "deepseek-v4-pro", scopeKey: "s1", base: "main-x", reps: 1, codes: ["返信"], flake: "stable", reused: false, envFp: null, ...o });

// 1. 種: 6つ・鍵は一意で形が正しい・質に関わる物は needs_owner
ok(SEED_SAVINGS.length === 6, "種は6つ");
ok(new Set(SEED_SAVINGS.map((s) => s.key)).size === 6 && SEED_SAVINGS.every((s) => isSavingKey(s.key)), "種の鍵は一意で形が正しい");
ok(SEED_SAVINGS.filter((s) => !s.safe).every((s) => s.status === "needs_owner"), "質に関わる種は竹内さんの判断待ち");
ok(SEED_SAVINGS.find((s) => s.key === "version-same-content")?.est_usd_per_day === 9.9, "main の作り直しは $9.9/日");

// 2. 1回あたりの費用
const cpr = costPerRepByLabel([U({ usd: 0.3 }), U({ usd: 0.3 }), U({ route: "script:brain-exam-other", usd: 9 })], [L({ reps: 3 }), L({ id: "q2", reps: 3 })]);
ok(Math.abs((cpr.get("a1") ?? 0) - 0.1) < 1e-9, "a1 は $0.6 ÷ 6回 = $0.1");

// 3. main の答えの作り直し
const bw = detectBaselineWaste([
  { version: "v-b", id: "q1", savedAt: "x", realUsd: 0.5, realCalls: 10, pinnedFrom: "v-a", sameAnswersAsPrev: true, allInputSame: false },
  { version: "v-b", id: "q2", savedAt: "x", realUsd: 0.4, realCalls: 8, pinnedFrom: "v-a", sameAnswersAsPrev: false, allInputSame: false },
  { version: "v-b", id: "q3", savedAt: "x", realUsd: 0.2, realCalls: 3, pinnedFrom: "v-a", sameAnswersAsPrev: true, allInputSame: true },
  { version: "v-b", id: "q4", savedAt: "x", realUsd: 0, realCalls: 0, pinnedFrom: "v-a", sameAnswersAsPrev: true, allInputSame: false },
]);
ok(bw.find((h) => h.key === "version-same-content")?.usd === 0.5, "答えが同じだった作り直しだけ数える（$0.5）");
ok(bw.find((h) => h.key === "regen-same-input")?.usd === 0.2, "入力が同じなのに呼んだ（$0.2）");

// 4. 2倍の時間（待てた物の半分）
const isPeak = (d: Date) => d.getUTCHours() >= 6 && d.getUTCHours() < 10;
const nextCheap = (d: Date) => { const x = new Date(d); x.setUTCHours(10, 0, 0, 0); return x; };
const pk = detectPeak([U({ created_at: "2026-10-23T09:40:00Z", usd: 0.2 }), U({ created_at: "2026-10-23T06:10:00Z", usd: 1 }), U({ created_at: "2026-10-23T12:00:00Z", usd: 5 })], isPeak, nextCheap);
ok(pk.length === 1 && pk[0].usd === 0.1 && pk[0].evidence.counts?.peak === 2 && pk[0].evidence.counts?.waitable === 1, "2倍の時間: 安い時間まで60分以内の物の半額だけ（$0.1）");

// 5. flash で足りる型
const fl = detectFlashEligible([L({ reps: 2 }), L({ id: "q2", type: "謝罪を受ける" }), L({ id: "q3", model: "deepseek-flash" })], { 初回: { n: 3, samePath: 3 }, 謝罪を受ける: { n: 2, samePath: 0 } }, new Map([["a1", 0.1]]), 5, [U({}), U({ model: "deepseek-flash" })]);
ok(fl.length === 1 && Math.abs(fl[0].usd - 0.15) < 1e-9, "道が全部同じ型を pro で2回＝$0.2×0.75");
ok(/flash の割合 50%/.test(fl[0].detail ?? ""), "flash の割合を出す");

// 6. キャッシュ
const cm = detectCacheMiss(Array.from({ length: 30 }, () => U({ input_uncached: 12000, cache_read: 36000 })));
ok(cm.length === 1 && cm[0].key === "cache-miss:brain_fresh" && cm[0].usd > 0, "当たり 75%・外れ 1.2万 → 見つける");
ok(detectCacheMiss(Array.from({ length: 10 }, () => U({ input_uncached: 2000, cache_read: 40000 }))).length === 0, "当たり 95% は見つけない");

// 7. 重なり
const dup = detectDuplicateRuns([L({}), L({ label: "b1" }), L({ label: "c1", scopeKey: "s2" })], new Map([["a1", 0.1], ["b1", 0.2]]), [{ at: "", kind: "dup-refused", label: "z", ids: [], usd: 1 }]);
ok(dup.length === 1 && dup[0].usd === 0.2 && dup[0].evidence.counts?.refused === 1, "同じ問題×入力を別の回で→2本目の分");
ok(detectDuplicateRuns([L({}), L({ label: "b1", reused: true })], new Map(), []).length === 0, "使い回しは重なりでない");

// 8. 回数・出力
const ro = detectRepsOverkill([L({ reps: 3 }), L({ id: "q2", reps: 3, flake: "flaky" }), L({ id: "q3", reps: 3, codes: ["返信", "AIX"] })], new Map([["a1", 0.1]]));
ok(ro.length === 1 && Math.abs(ro[0].usd - 0.2) < 1e-9 && !ro[0].safe, "揺れない・全部同じ答えの余分な2回＝$0.2・質に関わる");
const ol = detectOverlongOutput([...Array.from({ length: 5 }, () => U({ output_tokens: 1200 })), ...Array.from({ length: 5 }, () => U({ action: "brain_full", output_tokens: 1100 }))]);
const olAgg = aggregateSavingHits(ol);
ok(olAgg.length === 1 && olAgg[0].key === "overlong-output:brain" && !olAgg[0].safe, "brain_fresh と brain_full は1つの鍵にまとまる");

// 9. スイッチが off → 自動で戻す
const env = { EXAM_INPUT_DIFF: "off", EXAM_PEAK_WAIT_MIN: "0", EXAM_WARM_COALESCE: "off", EXAM_JUDGE_CACHE: "on" };
const so = detectSwitchesOff(env, (n) => n !== "EXAM_WARM_COALESCE");
ok(so.map((h) => h.key).sort().join(",") === "switch-off:exam_input_diff,switch-off:exam_peak_wait_min", "off の質を変えないスイッチ（まだ無い他の担当のスイッチは除く）");
const plan = planAutoApply([...so, ...pk], env, { applied: [] }, "2026-10-23T12:00:00Z", (n) => n !== "EXAM_WARM_COALESCE");
ok(plan.length === 2 && plan.every((a) => a.value === null), "2つを既定に戻す計画");
ok(planAutoApply(so, env, { applied: plan }, "x").length === 0, "戻した物は二度足さない");
const e2: Record<string, string | undefined> = { ...env };
const notes = applyAutoToEnv(e2, { applied: plan }, new Set(["EXAM_PEAK_WAIT_MIN"]));
ok(e2.EXAM_INPUT_DIFF === undefined && e2.EXAM_PEAK_WAIT_MIN === "0" && notes.length === 2, "当てる（人が決めた名前は触らない）");
const e3: Record<string, string | undefined> = { ...env, EXAM_SAVINGS_AUTO: "off" };
ok(applyAutoToEnv(e3, { applied: plan }).length === 0 && e3.EXAM_INPUT_DIFF === "off", "EXAM_SAVINGS_AUTO=off は何もしない");
const e4: Record<string, string | undefined> = { EXAM_INPUT_DIFF: "on" };
ok(applyAutoToEnv(e4, { applied: plan }).length === 0, "off でない時は触らない");
ok(SAFE_ACTIONS.every((a) => a.offValues.length > 0), "スイッチの登録に off の値がある");

// 10. 行の足し合わせ・日ごとの $
const h0 = aggregateSavingHits(pk)[0];
const r1 = mergeSavingRow(null, { ...h0, at: "2026-10-23T03:00:00Z" }, "2026-10-23T03:00:00Z", { label: "a1" });
ok(r1.status === "open" && r1.occurrences === 1 && r1.evidence.days?.["2026-10-23"] === 0.1 && r1.evidence.run_labels?.[0] === "a1", "新しい鍵は open・今日の分・回の名前");
const r2 = mergeSavingRow(r1, { ...h0, at: "2026-10-23T04:00:00Z" }, "x", { mode: "add" });
ok(r2.occurrences === 2 && r2.evidence.days?.["2026-10-23"] === 0.2 && r2.est_usd_per_day === 0.2, "add は今日に足す");
const r3 = mergeSavingRow(r2, { ...h0, usd: 0.05, at: "2026-10-24T04:00:00Z" }, "x", { mode: "set" });
ok(r3.evidence.days?.["2026-10-24"] === 0.05 && Math.abs(r3.est_usd_per_day - 0.125) < 1e-9, "set は今日を上書き・1日あたりは日の平均");
const ro1 = mergeSavingRow(null, aggregateSavingHits(ro)[0], "2026-10-23T03:00:00Z");
ok(ro1.status === "needs_owner", "質に関わる新しい案は needs_owner");
ok(perDayOf({}) === 0, "日の記録が無い＝0");

// 11. 竹内さんへの質問
const q = ownerQuestionFor({ key: "overlong-output:brain", title: "出力が長い", detail: "x", est_usd_per_day: 1.8, kind: "overlong_output" });
ok(q.dedupe_key === "exam-savings:overlong-output:brain" && q.topic === "費用" && typeof q.recommended === "string" && q.kind === "question", "質問は話題「費用」・推奨つき・dedupe");

// 12. 見せ方
ok(/上位 1/.test(renderTopSavings([{ key: "a", title: "A", status: "open", est_usd_per_day: 2, occurrences: 1, fix_ref: null, safe: true }, { key: "b", title: "B", status: "fixed", est_usd_per_day: 9, occurrences: 1, fix_ref: null, safe: true }])), "上位は開いている物だけ");
ok(/⚠ 直したのはず/.test(renderRunSavings(pk, [], [{ key: "peak-hour-calls", status: "fixed", fix_ref: "x" }])), "直したのに再び出たら ⚠");
ok(/見つからない/.test(renderRunSavings([], [])), "何も無い時");

// 13. 全部まとめて（例外を出さない）
ok(Array.isArray(detectSavings({ usage: [], baseline: [], ledger: [], modelCheckByType: {}, coord: [], isPeak, nextCheap, flashTypeMinN: 5 })), "空でも動く");

// 13b. 他の担当の直しが入った知らせ
const xn = externalFixNotes([{ key: "version-same-content", kind: "version_same_content", status: "open" }, { key: "peak-hour-calls", kind: "peak_hour", status: "open" }], (n) => n === "EXAM_MAIN_KEY");
ok(xn.length === 1 && /EXAM_MAIN_KEY/.test(xn[0]) && /version-same-content/.test(xn[0]), "main の鍵の直しが入ったら作り直しの案に知らせる");
ok(externalFixNotes([{ key: "version-same-content", kind: "version_same_content", status: "open" }], () => false).length === 0, "まだ入っていなければ知らせない");

// 14. 答えの比べ（io）
ok(sameAnswers([{ path: { code: "返信" }, score: { pass: true } }], [{ path: { code: "返信" }, score: { pass: true } }]) === true, "同じ答え");
ok(sameAnswers([{ path: { code: "返信" }, score: { pass: true } }], [{ path: { code: "AIX" }, score: { pass: true } }]) === false, "違う道");
ok(sameAnswers([{ path: { code: "返信" }, score: { pass: true } }], [{ path: { code: "返信" }, score: { pass: true } }, { path: { code: "返信" }, score: { pass: true } }]) === true, "回の数が違っても同じ答え");
ok(sameAnswers([], [{ path: { code: "返信" } }]) === null, "片方が無い＝分からない");

console.log(fail ? `\n${fail} FAIL` : "\nALL PASS");
process.exit(fail ? 1 : 0);
