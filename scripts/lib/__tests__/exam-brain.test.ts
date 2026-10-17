// 試験のブレイン（scripts/lib/exam-brain.ts）の決め方の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-brain.test.ts（全 PASS で exit 0）
import {
  mergePicks, firstReps, confirmTargets, draftEligible, draftTargets, compareProblem, brainChangedOf, stopDecision, isCheapWindow, nextCheapStart, decideWhen,
  reuseKey, kbKeyOf, canReuse, modelOf, estimateUsd, needJudge, contractShape, dbKeyOf, type PlanProblem, type RowLite, type DbPart,
  pickSmall, smallRank, decidePhase, SMALL_MAX_REPS, dailyCapUsd, jstDayStart, nextNightRun, capSplit, isProtected, peakAdvice, convKeyOf, convCtxHash,
} from "../exam-brain";
import { readDbFingerprint, dbTablesOf, DB_FINGERPRINT_TABLES, type DbTableSpec } from "../exam-brain-io";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const P = (id: string, type = "t", accept = ["返信"], tags: string[] = []): PlanProblem => ({ id, type, accept, tags });
const all = [P("q1"), P("q2", "t", ["AIX:x"]), P("q3", "t", ["返信"], ["お手本"]), P("q4"), P("q5", "u", ["2段:check"], ["竹内さんの番"])];

// 1. どの問題
{
  const r = mergePicks(all, { mode: "rag", picked: [{ id: "q1", why: ["差分の言葉に近い"], must: false }] }, { named: ["q4"], weakSpotProblems: { q2: ["abcdef12"] } });
  const ids = r.map((x) => x.id);
  ok("RAG＋名指し＋お手本＋竹内さんの番＋弱い所", ids.join() === "q1,q2,q3,q4,q5", ids.join());
  ok("RAG だけの問題は must でない", r.find((x) => x.id === "q1")!.must === false);
  ok("お手本は必ず", r.find((x) => x.id === "q3")!.must);
  ok("gate は全部", mergePicks(all, null, { gate: true }).length === 5);
  ok("選びが無い時は全部（安全側）", mergePicks(all, null, {}).length === 5);
  ok("無い id は足さない", !mergePicks(all, { mode: "rag", picked: [] }, { named: ["q999"] }).some((x) => x.id === "q999"));
}
// 2. 何回
ok("直しの確かめは全部1回", firstReps("flaky") === 1 && firstReps("stable") === 1 && firstReps("unknown") === 1);
ok("関所は揺れる問題だけ3回", firstReps("flaky", 3, { gate: true }) === 3 && firstReps("stable", 3, { gate: true }) === 1);
ok("確かめは前と違った問題（もう max 回ある問題は除く）", confirmTargets([{ id: "a", cmp: "worse" }, { id: "b", cmp: "same" }, { id: "c", cmp: "better" }, { id: "d", cmp: "worse" }], new Set(["d"])).join() === "a,c");
ok("はっきり良い時も悪化は確かめる（揺れる問題の悪化を1回で見逃さない）", confirmTargets([{ id: "a", cmp: "changed" }, { id: "w", cmp: "worse" }, { id: "c", cmp: "better" }], new Set(), { clearlyGood: true }).join() === "w,c");
ok("はっきり良い時は良くなった問題だけ",confirmTargets([{ id: "a", cmp: "changed" }, { id: "c", cmp: "better" }], new Set(), { clearlyGood: true }).join() === "c");
// 3. どこまで
ok("下書きの意味: AIX だけの正解は無し", !draftEligible(all[1]) && draftEligible(all[0]));
ok("下書きの意味: 出し切りの正解も見る", draftEligible({ id: "x", type: "t", accept: ["AIX:z"], acceptWhen: { searchExhausted: ["返信"] } }));
ok("下書きに効く変更は全部の候補", draftTargets("draft", all, new Set()).ids.join() === "q1,q3,q4,q5");
ok("ブレインだけの変更は判断が変わった問題だけ", draftTargets("brain", all, new Set(["q4", "q2"])).ids.join() === "q4");
ok("変更なし・判断も同じは0", draftTargets("none", all, new Set()).ids.length === 0);
// 2026-10-17 穴②: 関所はブレインだけの直しでも下書きを全部（下書きはブレインの meta を丸ごと受け取る＝判断が同じでも変わり得る）
ok("関所: ブレインだけの直し・判断が同じでも下書きは全部", draftTargets("brain", all, new Set(), { gate: true }).ids.join() === "q1,q3,q4,q5");
ok("関所: 変更なしでも下書きは全部（DB の変化は差分に出ない・使う物が同じなら前の結果を使う）", draftTargets("none", all, new Set(), { gate: true }).ids.join() === "q1,q3,q4,q5");
ok("関所でない: ブレインだけの直し・判断が同じは0", draftTargets("brain", all, new Set()).ids.length === 0);
// 比べ
const R = (ok1: boolean, pass1: boolean, code = "返信", d?: boolean): RowLite => ({ id: "x", rep: 1, path: { code, ok: ok1 }, score: { pass: pass1 }, draft: d === undefined ? null : { pass: d } });
ok("道が悪化", compareProblem([R(false, false)], [R(true, true)]).cmp === "worse");
ok("合格だけ良くなった", compareProblem([R(true, true)], [R(true, false)]).cmp === "better");
ok("判断だけ変わった", compareProblem([R(true, true, "2段:check")], [R(true, true, "返信")]).cmp === "changed");
ok("下書きの悪化", compareProblem([R(true, true, "返信", false)], [R(true, true, "返信", true)]).cmp === "worse");
ok("過半数で見る", compareProblem([R(true, true), R(true, true), R(false, false)], [R(true, true)]).cmp === "same");
ok("前が無い", compareProblem([R(true, true)], []).cmp === "nobase");
ok("失敗の行は数えない", compareProblem([{ id: "x", rep: 1, error: "e" }], [R(true, true)]).cmp === "nocur");
ok("判断が変わった集合", [...brainChangedOf([{ id: "a", cmp: "same" }, { id: "b", cmp: "changed" }, { id: "c", cmp: "nobase" }])].join() === "b,c");
// 穴②: turn_contract の形（自由文でない欄だけ）
{
  const TC = (asks: Array<{ route: string; aix?: string | null; quote?: string; answer?: string }>, close = false, extra: Record<string, unknown> = {}) => ({ asks: asks.map((a) => ({ kind: "request", basis: "judgement", quote: "q", answer: "a", aix: null, ...a })), lead_with: 0, close_only: close, must_not: ["x"], proposals: [], feeling: null, ...extra });
  const RB = (tc: unknown, code = "返信"): RowLite => ({ ...R(true, true, code), brain: { turn_contract: tc } });
  ok("形: 自由文（quote・answer・must_not）が違うだけなら同じ", contractShape(TC([{ route: "reply", quote: "物件は？", answer: "あります" }])) === contractShape({ ...TC([{ route: "reply", quote: "別の言葉", answer: "別" }]), must_not: ["y", "z"], proposals: ["抑える"] }));
  ok("形: 並びは見ない", contractShape(TC([{ route: "reply" }, { route: "promise" }])) === contractShape(TC([{ route: "promise" }, { route: "reply" }])));
  ok("形: route が変われば別", contractShape(TC([{ route: "reply" }])) !== contractShape(TC([{ route: "promise" }])));
  ok("形: close_only（\"true\" の文字も）が変われば別", contractShape(TC([], false)) !== contractShape(TC([], true)) && contractShape(TC([], true)) === contractShape({ ...TC([]), close_only: "true" }));
  ok("形: aix のキー・ack_form・気持ちを受けるか", contractShape(TC([{ route: "aix", aix: "property_send" }])) !== contractShape(TC([{ route: "aix", aix: "property_search" }]))
    && contractShape(TC([], true, { ack_form: "wait_line" })) !== contractShape(TC([], true, { ack_form: "receive_only" }))
    && contractShape(TC([], false, { feeling: { kind: "anxious", acknowledge: true } })) !== contractShape(TC([], false, { feeling: { kind: "anxious", acknowledge: false } })));
  ok("形: turn_contract が無いと null", contractShape(null) === null && contractShape(undefined) === null);
  const sh = compareProblem([RB(TC([{ route: "reply" }], true))], [RB(TC([{ route: "promise" }]))]);
  ok("比べ: 道・合否・符号が同じでも形が変われば shape", sh.cmp === "shape", sh.why);
  ok("比べ: 自由文だけ違えば same", compareProblem([RB(TC([{ route: "reply", answer: "x" }]))], [RB(TC([{ route: "reply", answer: "y" }]))]).cmp === "same");
  ok("比べ: 片方に形が無い（古い答案）は比べない", compareProblem([RB(TC([{ route: "reply" }]))], [R(true, true)]).cmp === "same");
  ok("比べ: 符号が変われば changed が先", compareProblem([RB(TC([{ route: "promise" }]), "2段:check")], [RB(TC([{ route: "reply" }]))]).cmp === "changed");
  ok("形の変化は下書きへ（判断が変わった集合に入る）", brainChangedOf([{ id: "a", cmp: "shape" }]).has("a"));
  ok("形の変化は確かめの回に足さない（合否は同じ）", confirmTargets([{ id: "a", cmp: "shape" }], new Set()).length === 0);
  ok("形の変化は途中で止める数に入れない", stopDecision([{ id: "a", cmp: "shape" }, { id: "b", cmp: "shape" }, { id: "c", cmp: "shape" }, { id: "d", cmp: "shape" }], new Set()).action === "go");
  ok("関所でない・ブレインだけの直し: 形が変わった問題は下書きまで", draftTargets("brain", all, brainChangedOf([{ id: "q3", cmp: "shape" }, { id: "q1", cmp: "same" }])).ids.join() === "q3");
}
// 5. 途中で止める
{
  const cm = (xs: string) => xs.split(",").map((c, i) => ({ id: `p${i}`, cmp: c as never }));
  ok("はっきり悪化で止める", stopDecision(cm("worse,worse,worse,same"), new Set()).action === "stop");
  ok("数が少ない内は止めない", stopDecision(cm("worse,worse,worse"), new Set()).action === "go");
  ok("揺れる問題の悪化は数えない", stopDecision(cm("worse,worse,worse,same,same"), new Set(["p0"])).action === "go");
  ok("良くなった分を差し引く", stopDecision(cm("worse,worse,worse,better,better"), new Set()).action === "go");
  ok("はっきり良い", stopDecision(cm("better,better,better,same"), new Set()).action === "fewer");
}
// 4. いつ（JST 1:30〜9:30・混雑の外）
{
  const at = (jst: string) => new Date(Date.parse(`${jst}+09:00`));
  ok("JST 3:00 は安い", isCheapWindow(at("2026-10-19T03:00:00")));
  ok("JST 9:30 は安くない", !isCheapWindow(at("2026-10-19T09:30:00")));
  ok("JST 11:00（混雑）は安くない", !isCheapWindow(at("2026-10-19T11:00:00")));
  ok("JST 23:00 → 翌 1:30", nextCheapStart(at("2026-10-19T23:00:00")).toISOString() === at("2026-10-20T01:30:00").toISOString(), nextCheapStart(at("2026-10-19T23:00:00")).toISOString());
  ok("JST 0:10 → 当日 1:30", nextCheapStart(at("2026-10-19T00:10:00")).toISOString() === at("2026-10-19T01:30:00").toISOString());
  ok("小さい試験は今", decideWhen({ when: "auto", estUsd: 0.3, now: at("2026-10-19T11:00:00") }).runNow);
  ok("関所は昼なら予約", !decideWhen({ when: "auto", estUsd: 0.3, gate: true, now: at("2026-10-19T11:00:00") }).runNow);
  ok("関所でも安い時間なら今", decideWhen({ when: "auto", estUsd: 5, gate: true, now: at("2026-10-19T03:00:00") }).runNow);
  ok("now は今", decideWhen({ when: "now", estUsd: 9, gate: true, now: at("2026-10-19T11:00:00") }).runNow);
}
// 6. 使い回し
{
  const base = { problemHash: "h", stage: "brain" as const, scopeKey: "s", toolKey: "t", cfgHash: "c", model: "m", kbKey: "k", dbKey: "d" };
  const k = reuseKey(base);
  ok("鍵は使う物が同じなら同じ", k === reuseKey({ ...base }));
  ok("効くファイルが変われば別", k !== reuseKey({ ...base, scopeKey: "s2" }) && k !== reuseKey({ ...base, kbKey: "k2" }) && k !== reuseKey({ ...base, stage: "draft" }));
  ok("DB の指紋が変われば別（穴③）", k !== reuseKey({ ...base, dbKey: "d2" }));
  ok("知見の版は紐付く物だけ", kbKeyOf([{ kbId: "a" }], { a: "1", b: "2" }) === kbKeyOf([{ kbId: "a" }], { a: "1", b: "3" }) && kbKeyOf([{ kbId: "a" }], { a: "1" }) !== kbKeyOf([{ kbId: "a" }], { a: "9" }));
  const now = Date.parse("2026-10-17T00:00:00Z");
  const e = { key: k, savedAt: "2026-10-16T00:00:00Z", rows: [R(true, true)] };
  ok("使い回せる", canReuse(e, k, 1, now));
  ok("回数が足りないと使わない", !canReuse(e, k, 3, now));
  ok("古いと使わない", !canReuse({ ...e, savedAt: "2026-10-01T00:00:00Z" }, k, 1, now));
  ok("鍵が違うと使わない", !canReuse(e, "x", 1, now));
  ok("失敗の行があると使わない", !canReuse({ ...e, rows: [R(true, true), { id: "x", rep: 2, error: "e" }] }, k, 1, now));
}
// 6. DB の表の指紋（穴③・本物の DB は使わない）
{
  const parts: DbPart[] = [{ table: "a", ok: true, sig: "n=1" }, { table: "b", ok: true, sig: "n=2" }, { table: "c", ok: false, sig: "", why: "x" }];
  ok("DB の鍵: 段が読む表だけ・並びは見ない", dbKeyOf(parts, ["a", "b"]) === dbKeyOf(parts, ["b", "a"]) && dbKeyOf(parts, ["a"]) !== dbKeyOf(parts, ["a", "b"]));
  ok("DB の鍵: 中身が変われば別", dbKeyOf(parts, ["a"]) !== dbKeyOf([{ table: "a", ok: true, sig: "n=9" }], ["a"]));
  ok("DB の鍵: 読めない表があれば null（使い回さない）", dbKeyOf(parts, ["a", "c"]) === null);
  ok("DB の鍵: 読んでいない表があれば null", dbKeyOf(parts, ["a", "z"]) === null && dbKeyOf(null, ["a"]) === null);
  const br = dbTablesOf("brain"), dr = dbTablesOf("draft");
  ok("表の一覧: ブレインが毎回読む知見・決まり・手本・統計", ["ai_reply_knowledge", "ai_prompt_rules", "ai_reply_examples", "trigger_action_rules", "aix_transition_stats", "brain_aix_feedback", "templates", "winning_patterns"].every((t) => br.includes(t)), br.join());
  ok("表の一覧: 下書きは下書きだけの表も", ["ai_prompts", "adaptation_improvement_rules", "phrase_dictionary"].every((t) => dr.includes(t) && !br.includes(t)) && br.every((t) => dr.includes(t)));
  ok("表の一覧: 会話ごとの表は入れない", !["messages", "conversations", "property_customers", "brain_decision_logs"].some((t) => dr.includes(t)));
  // 読み方（偽の DB）: 件数・時刻・絞った件数・小さい表の中身の hash
  const db: Record<string, Array<Record<string, unknown>>> = {
    k: [{ id: 1, category: "principle", updated_at: "2026-10-10" }, { id: 2, category: "x", updated_at: "2026-10-12" }],
    s: [{ id: 2, v: "b" }, { id: 1, v: "a" }],
  };
  const fake = (broken: string[] = []) => ({ from: (t: string) => {
    const st: { filters: Array<[string, unknown]>; order: string[]; head: boolean; cols: string; limit?: number } = { filters: [], order: [], head: false, cols: "*" };
    const run = () => {
      if (broken.includes(t) || !db[t]) return { data: null, count: null, error: { message: `no table ${t}` } };
      let rows = db[t].filter((r) => st.filters.every(([c, v]) => r[c] === v));
      for (const o of [...st.order].reverse()) rows = [...rows].sort((a, b) => String(a[o.replace("-", "")]).localeCompare(String(b[o.replace("-", "")])) * (o.startsWith("-") ? -1 : 1));
      if (st.limit) rows = rows.slice(0, st.limit);
      const cols = st.cols === "*" ? null : st.cols.split(",");
      return { data: st.head ? null : rows.map((r) => cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r), count: rows.length, error: null };
    };
    const q: Record<string, unknown> = {
      select: (cols: string, o?: { head?: boolean }) => { st.cols = cols; st.head = !!o?.head; return q; },
      eq: (c: string, v: unknown) => { st.filters.push([c, v]); return q; },
      neq: (c: string, v: unknown) => { st.filters.push([c, { neq: v }]); return q; },
      order: (c: string, o?: { ascending?: boolean }) => { st.order.push(o?.ascending === false ? `-${c}` : c); return q; },
      limit: (n: number) => { st.limit = n; return q; },
      range: (a: number, b: number) => { st.limit = b - a + 1; return q; },
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  } });
  const specs: DbTableSpec[] = [
    { table: "k", stages: ["brain"], ts: "updated_at", counts: { principle: ["category", "eq", "principle"] } },
    { table: "s", stages: ["draft"], hash: { cols: ["id", "v"], order: ["id"] } },
  ];
  void (async () => {
    const a = await readDbFingerprint(fake() as never, specs);
    ok("指紋: 件数・絞った件数・最終の時刻", a[0].ok && a[0].sig === "n=2;principle=1;updated_at=2026-10-12", a[0].sig);
    ok("指紋: 小さい表は中身の hash", a[1].ok && /^n=2;h=[0-9a-f]{12}$/.test(a[1].sig), a[1].sig);
    db.s[0].v = "B";
    const b = await readDbFingerprint(fake() as never, specs);
    ok("指紋: 件数が同じでも中身の編集を拾う", b[1].sig !== a[1].sig && b[0].sig === a[0].sig);
    const c = await readDbFingerprint(fake(["k"]) as never, specs);
    ok("指紋: 読めない表は ok=false → その段の鍵は null", !c[0].ok && dbKeyOf(c, ["k"]) === null && dbKeyOf(c, ["s"]) !== null);
    ok("指紋: 本当の一覧はどれも表の名前が重ならない", new Set(DB_FINGERPRINT_TABLES.map((x) => x.table)).size === DB_FINGERPRINT_TABLES.length);
    console.log(`exam-brain: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
  })();
}
// 8. モデル
ok("既定は pro", modelOf(all[0], { mode: "pro", flashOkTypes: new Set(["t"]) }) === "pro");
ok("auto は比べで良かった型だけ flash", modelOf(all[0], { mode: "auto", flashOkTypes: new Set(["t"]) }) === "flash" && modelOf(all[4], { mode: "auto", flashOkTypes: new Set(["t"]) }) === "pro");
ok("関所は常に pro", modelOf(all[0], { mode: "flash", flashOkTypes: new Set(), gate: true }) === "pro");
// 見込み
{
  const e = estimateUsd([{ id: "a", reps: 1, draft: false, reuse: false, model: "pro", why: [] }, { id: "b", reps: 3, draft: true, reuse: false, model: "pro", why: [] }, { id: "c", reps: 1, draft: false, reuse: true, model: "pro", why: [] }]);
  ok("見込み: 使い回しは0", Math.abs(e.now - (0.03 + 0.045 * 3)) < 1e-9, String(e.now));
}
// 7. 採点
ok("依頼も禁止も無い時は呼ばない", !needJudge({ asks: 0, ng: 0, needRawPath: false, pathOk: true, lazy: false }));
ok("lazy: 道が外れ・本質も決まりなら呼ばない", !needJudge({ asks: 2, ng: 1, needRawPath: false, pathOk: false, lazy: true }));
ok("lazy: 本質の道が要れば呼ぶ", needJudge({ asks: 2, ng: 0, needRawPath: true, pathOk: false, lazy: true }));
ok("lazy: 道が合えば呼ぶ", needJudge({ asks: 2, ng: 0, needRawPath: false, pathOk: true, lazy: true }));

// ─── 10/17 ① 2段（小さな確かめ／仕上げ） ───────────────────────────────
{
  const pk = (id: string, why: string[]) => ({ id, why, must: false });
  const picks = [
    pk("a", ["差分の言葉に近い（0.410・上位 3）"]), pk("b", ["竹内さんのお手本（必ず）"]), pk("c", ["前に落ちた"]), pk("d", ["差分の言葉に近い（0.520・上位 1）"]),
    pk("e", ["名指し"]), pk("f", ["毎日拾った弱い所の知見 abc に紐付く"]), pk("g", ["新しい問題（まだ回していない）"]), pk("h", ["竹内さんの番（必ず）"]),
    pk("i", ["知見 abcd1234 を変えた（近い知見）"]), pk("j", ["差分・言葉で名指し"]), pk("k", ["差分の言葉に近い（0.300・上位 5）"]),
  ];
  const s = pickSmall(picks, { max: 6 });
  ok("小さな確かめ: 名指し→前に落ちた→近い順→お手本（6問）", s.map((x) => x.id).sort().join() === ["e", "j", "c", "d", "a", "k"].sort().join(), s.map((x) => x.id).join());
  ok("小さな確かめ: 既定は8問まで", pickSmall(picks).length === 8);
  ok("小さな確かめ: 名指しは上限を超えても全部", pickSmall([pk("x", ["名指し"]), pk("y", ["名指し"]), pk("z", ["前に落ちた"])], { max: 1 }).map((x) => x.id).join() === "x,y");
  ok("近さの順: 知見を変えた（近さ無し）は近い問題と同じ段", smallRank(["知見 abcd1234 を変えた（近い知見）"]).tier === 2 && smallRank(["差分の言葉に近い（0.5"]).sim === 0.5);
  const hist = [{ at: "2026-10-17T01:00:00Z", label: "s1", phase: "small" as const, keys: "K1", clean: true, ids: ["a"] }, { at: "2026-10-17T00:00:00Z", label: "s0", phase: "small" as const, keys: "K2", clean: false, ids: ["a"] }];
  ok("形: 同じ版の小さな確かめが通った → 仕上げ", decidePhase({ pickCount: 20, keys: "K1", history: hist }).phase === "final");
  ok("形: 同じ版の小さな確かめに悪化 → 小さな確かめ", decidePhase({ pickCount: 20, keys: "K2", history: hist }).phase === "small");
  ok("形: この版が初めて → 小さな確かめ", decidePhase({ pickCount: 20, keys: "K3", history: hist }).phase === "small");
  ok("形: 8問以下は仕上げ", decidePhase({ pickCount: 8, keys: "K3", history: [] }).phase === "final");
  ok("形: 関所は仕上げ", decidePhase({ gate: true, pickCount: 150, keys: "K3", history: [] }).phase === "final");
  ok("形: --phase 明示・off＝旧", decidePhase({ explicit: "small", gate: true, pickCount: 3, keys: "K1", history: hist }).phase === "small" && decidePhase({ explicit: "off", pickCount: 20, keys: "K1", history: hist }).phase === "off" && decidePhase({ explicit: "final", pickCount: 20, keys: "K3", history: [] }).phase === "final");
  ok("小さな確かめの繰り返しは2回まで", SMALL_MAX_REPS === 2);
}
// ─── 10/17 ② 1日の上限 ─────────────────────────────────────────────
{
  ok("上限: 既定 10・off で無し・本番は無し", dailyCapUsd({}) === 10 && dailyCapUsd({ EXAM_DAILY_CAP_USD: "off" }) === null && dailyCapUsd({ EXAM_DAILY_CAP_USD: "4.5" }) === 4.5 && dailyCapUsd({ VERCEL_ENV: "production" }) === null);
  const at = (jst: string) => new Date(Date.parse(`${jst}+09:00`));
  ok("JST の日の始まり", jstDayStart(at("2026-10-17T00:30:00")).toISOString() === "2026-10-16T15:00:00.000Z" && jstDayStart(at("2026-10-17T23:59:00")).toISOString() === "2026-10-16T15:00:00.000Z");
  ok("夜中の予約: 昼なら翌日 1:40", nextNightRun(at("2026-10-17T14:00:00")).toISOString() === at("2026-10-18T01:40:00").toISOString());
  ok("夜中の予約: 0:30 ならその日の 1:40・2:00 なら翌日", nextNightRun(at("2026-10-17T00:30:00")).toISOString() === at("2026-10-17T01:40:00").toISOString() && nextNightRun(at("2026-10-17T02:00:00")).toISOString() === at("2026-10-18T01:40:00").toISOString());
  const why: Record<string, string[]> = { a: ["前に落ちた"], b: ["差分の言葉に近い（0.4"], c: ["竹内さんのお手本（必ず）"], d: ["名指し"], e: ["新しい問題"] };
  const base = { ids: ["a", "b", "c", "d", "e"], whyOf: (id: string) => why[id], estOf: (ids: string[]) => ids.length * 1 };
  ok("上限: 収まれば全部今", capSplit({ ...base, usedUsd: 4, cap: 10 }).mode === "ok");
  const s = capSplit({ ...base, usedUsd: 6, cap: 10 });
  ok("上限: 超えたら守る線（前に落ちた・お手本・名指し）を今・残りを夜中", s.mode === "split" && s.now.join() === "a,c,d" && s.later.join() === "b,e" && s.estLater === 2, JSON.stringify(s));
  const n = capSplit({ ...base, usedUsd: 8, cap: 10 });
  ok("上限: 守る線だけでも超えるなら全部夜中（止めない）", n.mode === "night" && n.now.length === 0 && n.later.length === 5);
  ok("上限: --over-cap は全部今", capSplit({ ...base, usedUsd: 9, cap: 10, force: true }).mode === "force");
  ok("上限: off は全部今", capSplit({ ...base, usedUsd: 99, cap: null }).mode === "off");
  ok("守る線の札", isProtected(["差分・言葉で名指し"]) && isProtected(["竹内さんの番（必ず）"]) && !isProtected(["差分の言葉に近い（0.5"]));
  // 2倍の時間（2026-10-19 は月曜）
  const pk = peakAdvice({ now: at("2026-10-19T11:00:00"), phase: "final", when: "auto" });
  ok("2倍の時間: 仕上げは夜中・警告", pk.peak && pk.defer && !!pk.warn);
  const ps = peakAdvice({ now: at("2026-10-19T11:00:00"), phase: "small", when: "auto" });
  ok("2倍の時間: 小さな確かめは警告だけ（今流す）", ps.peak && !ps.defer && !!ps.warn);
  ok("2倍の時間の外（13:30・土曜）は警告なし", !peakAdvice({ now: at("2026-10-19T13:30:00"), phase: "final", when: "auto" }).peak && !peakAdvice({ now: at("2026-10-17T11:00:00"), phase: "final", when: "auto" }).peak);
  ok("2倍の時間: --when=now・関所は夜中に回さない（関所は今まで通り）", !peakAdvice({ now: at("2026-10-19T11:00:00"), phase: "final", when: "now" }).defer && !peakAdvice({ now: at("2026-10-19T11:00:00"), phase: "final", gate: true, when: "auto" }).defer);
}
// ─── 10/17 ③ 会話の鍵 ─────────────────────────────────────────────
{
  const C = (name: string, conv: Record<string, unknown> = { account: "sumora" }, gaps: Record<string, number> = {}) => ({ name, ok: true, conv, pc: { status: "x" }, gaps });
  const all = [C("YUMA2"), C("YUMA3"), C("YUMA4"), C("YUMA5")];
  const k = convKeyOf(all[2], all);
  ok("会話の鍵: 全部同じ → '-'（会話を鍵に足さない）", k.key === "-", k.why);
  ok("会話の鍵: 名前・id は効く所に入らない", convCtxHash({ ...C("YUMA4"), conv: { account: "sumora", customer_name: "YUMA4", id: "x" } }) === convCtxHash({ ...C("YUMA5"), conv: { account: "sumora", customer_name: "YUMA5", id: "y" } }));
  const k2 = convKeyOf(C("YUMA", { account: "sumora" }, { deal_outcomes: 3 }), all);
  ok("会話の鍵: 線で隠せない行がある会話 → 会話の指紋を鍵に", !!k2.key && k2.key !== "-", k2.why);
  ok("会話の鍵: 読めない → null（使い回さない）", convKeyOf({ name: "YUMA4", ok: false, conv: null, pc: null, gaps: {}, why: "x" }, all).key === null);
  const b = { problemHash: "h", stage: "brain" as const, scopeKey: "s", toolKey: "t", cfgHash: "c", model: "m", kbKey: "k", dbKey: "d" };
  ok("鍵: 会話が効かない（'-'）時は旧の鍵と同じ＝今までの置き場を使える", reuseKey({ ...b, convKey: "-" }) === reuseKey(b) && reuseKey({ ...b, convKey: "abc" }) !== reuseKey(b));
}

// 終わりの数え（上の非同期の指紋のテストの後で出す）
