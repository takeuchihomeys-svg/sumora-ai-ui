// 試験のブレインを LINE のブレインの組み方に寄せた所（2026-10-20）の単体テスト（LLM も DB も使わない）
//   COST① main の答えの持ち越し・取り置きの予約／COST② 自信で回数を決める／COST③ flash の選び／QUALITY⑤〜⑧ の決まった所
// 実行: npx tsx scripts/lib/__tests__/exam-brain-like-line.test.ts（全 PASS で exit 0）
import { examStageKeysOf, type FileMap } from "../exam-scope";
import { findCarryOver, relevantStageOf, siblingDirs, type BaselineFile } from "../brain-exam-baseline";
import { modelOf, flashProof, isFixTarget, UNIT_USD, type PlanProblem } from "../exam-brain";
import { buildConductorUser, watchNeighbors, normalizePlan, type Candidate } from "../exam-conductor";
import { custKindOf, staffKindOf, sceneSim, crossCheck, findConflicts, groupConflicts, kbHitsFor, conflictPeers, bigramSim, type GoldProblem } from "../exam-gold-check";
import { piiGate, dedupeCandidates, rankCandidates, toAddBatch, type QCand } from "../exam-question-candidates";
import { failedOf, machineHint, machineReason, parseReason, aggregateReasons, buildReaderUser, READER_SYSTEM, REASON_KINDS, type ReaderRow } from "../exam-failure-reader";
import { warmDecision, warmLimit, repsModeOf, firstRepsOf, warmRepsOf, confidenceRound2, confidenceRound3, repSig, type Cmp, type RowLite } from "../exam-brain";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// ─── COST① 段ごとの main の鍵 ─────────────────────────────────────────────
{
  const files: FileMap = new Map([
    ["app/lib/brain-core.ts", `import "./shared"; import "./brain-only";`], ["app/lib/brain-layers.ts", ``], ["app/lib/deepseek-scope.ts", ``], ["app/lib/reply-context.ts", ``],
    ["app/lib/shared.ts", ``], ["app/lib/brain-only.ts", ``],
    ["app/api/generate-reply/route.ts", `import "@/app/lib/shared"; import "@/app/lib/draft-only";`], ["app/lib/draft-only.ts", ``], ["app/lib/reply-hint-auto.ts", ``],
    ["app/lib/unused.ts", ``],
  ]);
  const blobs = (over: Record<string, string> = {}) => new Map([...[...files.keys()].map((p) => [p, `b-${p}`] as [string, string]), ["package.json", "pk"], ["README.md", "r"], ...Object.entries(over)]);
  const k0 = examStageKeysOf(files, blobs());
  const kd = examStageKeysOf(files, blobs({ "app/lib/draft-only.ts": "changed" }));
  const kb = examStageKeysOf(files, blobs({ "app/lib/brain-only.ts": "changed" }));
  const ks = examStageKeysOf(files, blobs({ "app/lib/shared.ts": "changed" }));
  const ku = examStageKeysOf(files, blobs({ "app/lib/unused.ts": "x", "README.md": "y" }));
  ok("段の鍵: 下書きだけのファイルが変わる → ブレインの鍵は同じ・下書きの鍵は違う", kd.brain === k0.brain && kd.draft !== k0.draft);
  ok("段の鍵: ブレインのファイルが変わる → 両方違う（下書きはブレインを含む）", kb.brain !== k0.brain && kb.draft !== k0.draft);
  ok("段の鍵: 両方が読むファイル → 両方違う", ks.brain !== k0.brain && ks.draft !== k0.draft);
  ok("段の鍵: 読まれないファイル・文書 → どちらも同じ", ku.brain === k0.brain && ku.draft === k0.draft);
  ok("段の鍵: 設定（package.json）→ 両方違う", examStageKeysOf(files, blobs({ "package.json": "z" })).brain !== k0.brain);
}

// ─── COST① 前の main の答えの持ち越し ─────────────────────────────────────
{
  type R = { rep: number; error?: string };
  const now = Date.parse("2026-10-20T00:00:00Z");
  const mk = (o: Partial<BaselineFile<R>> & { dir?: string }): BaselineFile<R> & { dir?: string } => ({ id: "q1", problemHash: "h1", commit: "c1", config: { args: { stage: "brain" }, env: {} }, savedAt: "2026-10-19T00:00:00Z", fromLabel: "x", rows: [{ rep: 1 }], ...o });
  const keyOf = (b: BaselineFile<R>) => b.stageKeys?.brain ?? null;
  const want = { key: "KB", keyOf };
  ok("持ち越し: 同じ問題・同じ段の鍵 → 使う", findCarryOver([mk({ stageKeys: { brain: "KB", draft: "D1" } })], { hash: "h1" }, want, 1, { now })?.commit === "c1");
  ok("持ち越し: 段の鍵が違う（ブレインが変わった）→ 使わない", findCarryOver([mk({ stageKeys: { brain: "KX", draft: "D1" } })], { hash: "h1" }, want, 1, { now }) === null);
  ok("持ち越し: 鍵が分からない（古い置き場で commit も読めない）→ 使わない（安全側）", findCarryOver([mk({})], { hash: "h1" }, want, 1, { now }) === null);
  ok("持ち越し: 問題が直った（hash が違う）→ 使わない・旧の hash（alt）なら使う", findCarryOver([mk({ problemHash: "h0", stageKeys: { brain: "KB", draft: "" } })], { hash: "h1" }, want, 1, { now }) === null && findCarryOver([mk({ problemHash: "h0", stageKeys: { brain: "KB", draft: "" } })], { hash: "h1", alt: ["h0"] }, want, 1, { now }) !== null);
  ok("持ち越し: 期限より古い → 使わない", findCarryOver([mk({ stageKeys: { brain: "KB", draft: "" }, savedAt: "2026-10-01T00:00:00Z" })], { hash: "h1" }, want, 1, { now, maxAgeMs: 7 * 86_400_000 }) === null);
  ok("持ち越し: 失敗の回がある → 使わない", findCarryOver([mk({ stageKeys: { brain: "KB", draft: "" }, rows: [{ rep: 1, error: "x" }] })], { hash: "h1" }, want, 1, { now }) === null);
  ok("持ち越し: 回が足りない（3回要る・1回だけ）→ 使わない・揃った印（complete）なら使う", findCarryOver([mk({ stageKeys: { brain: "KB", draft: "" } })], { hash: "h1" }, want, 3, { now }) === null && findCarryOver([mk({ stageKeys: { brain: "KB", draft: "" }, complete: true })], { hash: "h1" }, want, 3, { now, acceptComplete: true }) !== null);
  const two = findCarryOver([mk({ stageKeys: { brain: "KB", draft: "" }, commit: "old", savedAt: "2026-10-18T00:00:00Z" }), mk({ stageKeys: { brain: "KB", draft: "" }, commit: "new", savedAt: "2026-10-19T12:00:00Z" })], { hash: "h1" }, want, 1, { now });
  ok("持ち越し: いくつもあれば一番新しい物", two?.commit === "new");
  ok("見る鍵: 構成の段が brain → ブレイン・それ以外（draft・auto・diff・無し）→ 下書き", relevantStageOf({ args: { stage: "brain" }, env: {} }) === "brain" && relevantStageOf({ args: { stage: "draft" }, env: {} }) === "draft" && relevantStageOf({ args: { stage: "auto" }, env: {} }) === "draft" && relevantStageOf(null) === "draft");
  ok("同じ構成の他の置き場だけ", siblingDirs(["v-a-C1", "v-b-C1", "v-c-C2", "c0ffee-C1", "main-head.json"], "C1", "v-a-C1").join() === "v-b-C1,c0ffee-C1");
}

// ─── COST① 取り置きの予約 ─────────────────────────────────────────────
{
  ok("予約: 新しい版 → 予約する", warmDecision({ vk: "v1", log: {}, queued: [] }).enqueue);
  ok("予約: 版が分からない → しない", !warmDecision({ vk: null, log: {}, queued: [] }).enqueue);
  ok("予約: 取り置き済み → しない・昼に答えの無い問題を夜に回した（force）→ する", !warmDecision({ vk: "v1", log: { v1: { at: "2026-10-20T00:00:00Z", commit: "c", done: true } }, queued: [] }).enqueue && warmDecision({ vk: "v1", log: { v1: { at: "2026-10-20T00:00:00Z", commit: "c", done: true } }, queued: [], force: true }).enqueue);
  ok("予約: もう予約がある → しない（force でも二重にしない）", !warmDecision({ vk: "v1", log: {}, queued: ["warm-auto-v1"], force: true }).enqueue);
  ok("予約: 途中（done=false）→ 続きを予約", warmDecision({ vk: "v1", log: { v1: { at: "2026-10-20T00:00:00Z", commit: "c", done: false, left: 5 } }, queued: [] }).enqueue);
  ok("回す数: 残り $1・1問 $0.03 → 33問／上限なし → null／使い切り → 0", warmLimit({ cap: 10, usedUsd: 9, unitUsd: 0.03 }) === 33 && warmLimit({ cap: null, usedUsd: 0, unitUsd: 0.03 }) === null && warmLimit({ cap: 10, usedUsd: 11, unitUsd: 0.03 }) === 0);
}

// ─── COST② 自信の気づき（回数） ─────────────────────────────────────────
{
  ok("回数の決め方: 既定 confidence・--reps=old / EXAM_REPS=old で旧", repsModeOf(undefined, {}) === "confidence" && repsModeOf("old", {}) === "old" && repsModeOf("", { EXAM_REPS: "old" }) === "old");
  ok("1回目: confidence は全部1回（最後の関所の揺れる問題も）・旧は関所の揺れる問題 3回", firstRepsOf("confidence", "flaky", 3, { gate: true }) === 1 && firstRepsOf("old", "flaky", 3, { gate: true }) === 3 && firstRepsOf("old", "stable", 3, { gate: true }) === 1);
  ok("取り置きの回: confidence は揺れる問題だけ2回・旧は3回", warmRepsOf("confidence", "flaky", 3) === 2 && warmRepsOf("confidence", "stable", 3) === 1 && warmRepsOf("confidence", "unknown", 3) === 1 && warmRepsOf("old", "flaky", 3) === 3);
  const x = (id: string, cmp: Cmp, failed = false, flake: "flaky" | "stable" | "unknown" = "unknown", have = 1) => ({ id, cmp, failed, flake, have });
  const xs = [x("a", "worse"), x("b", "better"), x("c", "changed"), x("d", "same"), x("e", "same", true), x("f", "same", true, "stable"), x("g", "same", false, "flaky"), x("h", "nobase", true), x("i", "nobase"), x("m", "nobase", false, "flaky"), x("j", "worse", false, "unknown", 2), x("k", "nocur", true), x("l", "shape")];
  const r2 = confidenceRound2(xs, { cap: 3 }).map((r) => r.id);
  ok("2回目（既定）: 前と違った・前が無くて外れた／揺れる問題だけ。前と同じ答え（外れ・揺れる問題でも）・形だけ・答案なし・もう2回ある問題は省く", r2.join() === "a,b,c,h,m", r2.join());
  const r2w = confidenceRound2(xs, { cap: 3, wide: true }).map((r) => r.id);
  ok("2回目（wide）: 前と同じでも外れ（いつもの外れ＝安定×前と同じは除く）・揺れる問題も回す", r2w.join() === "a,b,c,e,g,h,m", r2w.join());
  ok("回数の決め方: --reps=wide", repsModeOf("wide", {}) === "wide");
  ok("2回目: はっきり良い時は判断だけの変化を省く", confidenceRound2([x("c", "changed"), x("a", "worse")], { cap: 3, clearlyGood: true }).map((r) => r.id).join() === "a");
  ok("2回目: 上限1回（cap<2）なら無し", confidenceRound2([x("a", "worse")], { cap: 1 }).length === 0);
  const rows: Record<string, RowLite[]> = {
    s: [{ id: "s", rep: 1, path: { code: "返信", ok: true }, score: { pass: true } }, { id: "s", rep: 2, path: { code: "返信", ok: true }, score: { pass: true } }],
    t: [{ id: "t", rep: 1, path: { code: "返信", ok: true }, score: { pass: true } }, { id: "t", rep: 2, path: { code: "AIX:x", ok: false }, score: { pass: false } }],
    u: [{ id: "u", rep: 1, path: { code: "返信", ok: true }, score: { pass: true } }, { id: "u", rep: 2, path: { code: "返信", ok: true }, score: { pass: false } }],
    v: [{ id: "v", rep: 1, path: { code: "返信", ok: true }, score: { pass: true } }],
    w: [{ id: "w", rep: 1, path: { code: "返信", ok: true }, score: { pass: true } }, { id: "w", rep: 2, error: "x" }],
  };
  ok("3回目: 1回目と2回目が割れた問題だけ（道か合格が違う）・揃った・1回だけ・失敗の回は止める", confidenceRound3((id) => rows[id] ?? [], ["s", "t", "u", "v", "w"], 3).join() === "t,u");
  ok("3回目: 上限2回（小さな確かめ）なら無し", confidenceRound3((id) => rows[id] ?? [], ["t"], 2).length === 0);
  ok("回の印: 下書きの合否も見る", repSig({ id: "a", rep: 1, path: { code: "返信", ok: true }, score: { pass: true }, draft: { pass: true } }) !== repSig({ id: "a", rep: 1, path: { code: "返信", ok: true }, score: { pass: true }, draft: { pass: false } }));
}

// ─── COST③ flash の選び ─────────────────────────────────────────────
{
  const mc = flashProof({
    byType: { A: { n: 3, samePath: 3, proOk: 3, flashOk: 3 }, B: { n: 3, samePath: 2, proOk: 3, flashOk: 3 }, C: { n: 2, samePath: 2, proOk: 2, flashOk: 2 }, D: { n: 3, samePath: 3, proOk: 3, flashOk: 2 } },
    byId: { q1: { n: 2, samePath: 2, proOk: 1, flashOk: 1 }, q2: { n: 1, samePath: 1, proOk: 1, flashOk: 1 }, q3: { n: 2, samePath: 1, proOk: 1, flashOk: 1 } },
  });
  ok("型: 3問以上・道が同じ 9割以上・合う数が pro 以上だけ", [...mc.okTypes].join() === "A");
  ok("問題: 2回以上いつも同じ → flash・1回だけ → まだ・1回でも違った → flash にしない", [...mc.okIds].join() === "q1" && [...mc.badIds].join() === "q3");
  const P = (id: string, type: string): PlanProblem => ({ id, type });
  const o = { mode: "auto" as const, flashOkTypes: mc.okTypes, flashOkIds: mc.okIds, flashBadIds: mc.badIds };
  ok("auto: 確かめた型 → flash・確かめた問題 → flash・他 → pro", modelOf(P("x", "A"), o) === "flash" && modelOf(P("q1", "Z"), o) === "flash" && modelOf(P("y", "B"), o) === "pro");
  ok("auto: 型が通っていてもその問題で道が違った → pro", modelOf(P("q3", "A"), o) === "pro");
  ok("auto: 直しの的（名指し・前に落ちた）→ pro・関所 → pro・--model=pro → pro", modelOf(P("x", "A"), { ...o, protect: isFixTarget(["名指し"]) }) === "pro" && modelOf(P("x", "A"), { ...o, protect: isFixTarget(["前に落ちた（直前2回は道が合った）"]) }) === "pro" && modelOf(P("x", "A"), { ...o, gate: true }) === "flash".replace("flash", "pro") && modelOf(P("x", "A"), { ...o, mode: "pro" }) === "pro");
  ok("直しの的でない理由（RAG・お手本）→ flash のまま", !isFixTarget(["差分の言葉に近い（0.52）", "竹内さんのお手本（必ず）"]));
}

// ─── COST④ キャッシュの並び（司令塔の材料: 変わりにくい物が先・実行ごとに変わる物が後ろ） ─────────────
{
  const mk = (cls: string, cap: number) => buildConductorUser({ change: { cls, files: [{ file: `app/lib/${cls}.ts`, cls }], kbIds: [], commits: [], reading: null }, missTop: [{ kind: "約束の抜け", n: 3 }], linkMiss: [{ link: "L1", label: "x", n: 2, miss: 1 }], candidates: [], capUsd: cap, unit: UNIT_USD, flashOkTypes: ["A"], prevFocus: [], reasons: [{ kind: "道の取り違え", n: 2 }] });
  const a = mk("brain", 0.5), b = mk("draft", 0.3);
  let k = 0; while (k < a.length && a[k] === b[k]) k++;
  ok("並び: 外れの型・線・単価・外れの理由が先頭で同じ＝直した中身・上限が変わっても前置きが揃う", a.indexOf("【今までの外れの型") === 0 && k >= a.indexOf("【直した中身】") && a.indexOf("【直した中身】") < a.indexOf("【上限】") && a.includes("前の実行の外れの理由"), String(k));
}

// ─── QUALITY⑤ 外れの理由の読み手（決まった所） ─────────────────────────────────
{
  const R = (o: Partial<ReaderRow>): ReaderRow => ({ id: "q1", rep: 1, path: { code: "返信", ok: true }, score: { pass: true }, ...o });
  ok("外れ: 過半数が合格でない・答案なしは外れにしない", failedOf([R({ score: { pass: false } }), R({ rep: 2, score: { pass: false } }), R({ rep: 3 })]) && !failedOf([R({}), R({ rep: 2, score: { pass: false } }), R({ rep: 3 })]) && !failedOf([]));
  const ng = R({ score: { pass: false }, ng: [{ violated: true }], asks: [{ covered: true }] });
  ok("決まりで決まる: 道・依頼は合っていて言ってはいけない事に当たった → 言ってはいけない事（読み手を呼ばない）", machineReason("q1", [ng])?.kind === "言ってはいけない事");
  ok("決まりで決まらない: 道の外れ → 読み手へ", machineReason("q1", [R({ path: { code: "AIX:x", ok: false }, score: { pass: false } })]) === null);
  const hint = machineHint([R({ path: { code: "AIX:x", ok: false }, score: { pass: false } }), R({ rep: 2 })], [R({})]);
  ok("機械の手がかり: 道の外れ・回の割れ・前と違う・退行", hint.some((h) => h.includes("道が外れた")) && hint.some((h) => h.includes("割れた")) && hint.some((h) => h.includes("前（main）は道")) && !hint.some((h) => h.includes("退行")), hint.join("／"));
  ok("読み手の答え: 型が一覧に無い物は捨てる・根拠は60字まで・自信の既定は mid", parseReason("q1", '{"kind":"道の取り違え","evidence":"「確認します」と約束すべき所を返信で答えた"}')?.confidence === "mid" && parseReason("q1", '{"kind":"嘘の型"}') === null && parseReason("q1", "xx") === null);
  ok("読み手の答え: 前後の文・```・末尾のカンマも読む", parseReason("q1", 'はい\n```json\n{"kind":"判定の誤り","evidence":"x","confidence":"high",}\n```')?.kind === "判定の誤り");
  const agg = aggregateReasons([{ id: "a", kind: "依頼の抜け", evidence: "", confidence: "mid", by: "flash" }, { id: "b", kind: "道の取り違え", evidence: "", confidence: "mid", by: "flash" }, { id: "c", kind: "依頼の抜け", evidence: "", confidence: "mid", by: "flash" }]);
  ok("数え: 多い順・同じ数は型の順", agg.map((a) => `${a.kind}${a.n}`).join() === "依頼の抜け2,道の取り違え1" && agg[0].ids.join() === "a,c");
  const u1 = buildReaderUser({ id: "q1", type: "t", customer: "駐車場ありますか", accept: ["2段:check"], asks: [{ q: "駐車場", route: "promise", point: "確認" }] }, [R({ path: { code: "返信", ok: false }, score: { pass: false } })], [R({})]);
  const u2 = buildReaderUser({ id: "q1", type: "t", customer: "駐車場ありますか", accept: ["2段:check"], asks: [{ q: "駐車場", route: "promise", point: "確認" }] }, [R({ path: { code: "AIX:y", ok: false }, score: { pass: false } })], [R({})]);
  let k = 0; while (k < u1.length && u1[k] === u2[k]) k++;
  ok("キャッシュの並び: 問題と正解・前の答案が先（今の答案が変わっても前置きが揃う）", k >= u1.indexOf("【今の答案"), String(k));
  ok("型の定義は6つ全部 system に入る", REASON_KINDS.every((x) => READER_SYSTEM.includes(`- ${x}`)));
}

// ─── QUALITY⑥ 正解の食い違い ─────────────────────────────────────────────
{
  ok("発言の種類: お礼・了承だけ／質問／他", custKindOf("ありがとうございます🙇🏻‍♂️ よろしくお願い致します🙏") === "お礼・了承だけ" && custKindOf("よろしくお願います！") === "お礼・了承だけ" && custKindOf("駐車場ありますか？") === "質問" && custKindOf("いつもありがとうございます、来週引っ越します") === "他" && custKindOf("") === "他");
  ok("直前の送信の種類: 確認・交渉の約束／探す・送る約束／AIX／他／なし", staffKindOf("募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます") === "確認・交渉の約束" && staffKindOf("管理会社に礼金の交渉させていただきます") === "確認・交渉の約束" && staffKindOf("条件に合うお部屋をピックアップしてお送りさせて頂きます") === "探す・送る約束" && staffKindOf("x", true) === "AIX" && staffKindOf("いい物件ですね") === "他" && staffKindOf("") === "なし");
  const g = (id: string, accept: string[], mustNot: string[], customer = "よろしくお願いします！", lastStaff = "確認させて頂きます！！確認出来次第ご連絡させて頂きます", tags: string[] = []): GoldProblem => ({ id, type: "t", accept, mustNot, customer, lastStaff, tags });
  const q091 = g("q091", ["AIX:property_check_result"], ["2段:check", "返信"]), q143 = g("q143", ["返信", "2段:check"], ["AIX:zenryoku_support"], "よろしくお願います！", "管理会社に礼金の交渉をさせていただきます！！");
  const q176 = g("q176", ["AIX:property_check_result"], ["2段:check"]), qQ = g("qQ", ["AIX:viewing_invite"], [], "内見できますか？", "いい物件です");
  ok("場面の近さ: 同じ場面（お礼×確認の約束）は高い・質問で言葉が違えば0", sceneSim(q091, q143) >= 0.6 && sceneSim(qQ, g("qR", ["返信"], [], "初期費用はいくらですか？", "いい物件です")) === 0);
  ok("照らし: AIX の正解は返信の問題で通らず、返信の正解は AIX の問題の言ってはいけない道に当たる", !crossCheck(q091, q143).passes && crossCheck(q143, q091).hitsMustNot.length > 0);
  const cs = findConflicts([q091, q143, q176, qQ]);
  ok("食い違い: q091×q143・q143×q176 は強い・同じ正解同士（q091×q176）・別の場面（qQ）は出さない", cs.length === 2 && cs.every((c) => c.strength === "強い") && cs.every((c) => [c.a, c.b].includes("q143")), JSON.stringify(cs.map((c) => [c.a, c.b, c.strength])));
  const gr = groupConflicts(cs);
  ok("束: つながる組を1つに", gr.length === 1 && gr[0].ids.join() === "q091,q143,q176" && gr[0].strong);
  ok("食い違う相手: 両方向に引ける", conflictPeers(cs).q091?.[0]?.id === "q143" && conflictPeers(cs).q143?.length === 2);
  ok("設計知見を場面の言葉で引く（題・札は2点・本文は1点・0点は出さない）", kbHitsFor(["約束の後", "よろしく"], [{ id: "k1", title: "確認の約束の後のよろしく", insight: "" }, { id: "k2", title: "別の話", insight: "約束の後" }, { id: "k3", title: "x", insight: "y" }]).map((x) => x.id).join() === "k1,k2");
  ok("2字組の重なり: 同じ文 1・空 0", bigramSim("駐車場ありますか", "駐車場ありますか") === 1 && bigramSim("", "abc") === 0);
}

// ─── QUALITY⑦ 本番の外れから問題の候補 ─────────────────────────────────────
{
  const checks = { piiValueSignal: (t: string) => (/090-[0-9]{4}-[0-9]{4}/.test(t) ? "携帯" : null), applicationMaterialReason: (t: string) => (/本人確認書類/.test(t) ? "書類" : null) };
  ok("個人情報の網: 携帯・申込の書類が残る文は止める・無ければ通る", piiGate(["連絡は090-1234-5678"], checks)?.startsWith("個人の値") === true && piiGate(["本人確認書類を送ります"], checks)?.startsWith("申込の書類") === true && piiGate(["よろしくお願いします", ""], checks) === null);
  const C = (o: Partial<QCand>): QCand => ({ source: "見張り", conv: "c1", at: "2026-10-20T00:00:00Z", type: "返信かAIXか", tags: [], accept: [], mustNot: [], customer: "", staff: "", writer: "unknown", why: "", needs: ["正解の道"], ...o });
  const d = dedupeCandidates([C({}), C({ source: "直された番", at: "2026-10-20T01:00:00Z", accept: ["返信"], needs: [] }), C({ conv: "c2" }), C({ conv: "c3", at: "2026-10-19T00:00:00Z" })], [{ conv: "c3", at: "2026-10-19T02:00:00Z" }]);
  ok("重なり: もう試験に入っている番を外す・同じ番は新しい方を残して『も:』の札", d.keep.length === 2 && d.keep[0].source === "直された番" && d.keep[0].tags.includes("も:見張り") && d.dropped.some((x) => x.why === "もう試験に入っている"));
  const r = rankCandidates([C({ conv: "a", writer: "takeuchi", accept: ["返信"], needs: [], type: "多い型" }), C({ conv: "b", type: "少ない型" }), C({ conv: "c", type: "多い型" })], { typeCount: { 多い型: 40 }, now: Date.parse("2026-10-20T00:00:00Z") });
  ok("並べ方: 竹内さんの番・正解の道が決まっている物が先・少ない型は多い型より先", r[0].conv === "a" && r[1].conv === "b" && r[0].rankWhy.includes("竹内さんの番"));
  const b = toAddBatch(C({ tags: ["見張り", "も:直された番"], accept: ["AIX:x"], needs: [] }));
  ok("足せる形: 『も:』の札は外す・入れたのは誰か（人が確かめて足す）", JSON.stringify(b.tags) === JSON.stringify(["見張り"]) && String(b.addedBy).includes("人が確かめて"));
}

// ─── QUALITY⑧ 見張りの釣り合い ─────────────────────────────────────────────
{
  const W = (id: string, type: string, stage: "proposing" | "closing" | "cost", links: Array<"L1" | "L2">, lastOk: boolean | null, flaky = false, reuse = false) => ({ id, type, stage, links, lastOk, flaky, reuse });
  const pool = [W("a1", "T", "closing", [], true), W("a2", "T", "closing", [], true, true), W("a3", "T", "closing", [], false), W("b1", "U", "proposing", ["L1"], true), W("b2", "U", "proposing", [], true, false, true), W("c1", "V", "cost", [], true)];
  const w = watchNeighbors([{ id: "s1", type: "T", stage: "proposing", links: ["L1"] }], pool, { perFix: 3 });
  ok("見張り: 同じ型 → 同じ段・同じ線 → 同じ段の順・今合っている問題だけ・揺れる問題は後ろ", w.s1?.map((x) => x.id).join() === "a1,a2,b1", JSON.stringify(w));
  const w2 = watchNeighbors([{ id: "s1", type: "T", stage: "proposing", links: [] }, { id: "s2", type: "T", stage: "closing", links: [] }], pool, { perFix: 1, max: 2 });
  ok("見張り: 同じ問題は2回使わない・全部で max まで", w2.s1?.[0]?.id === "a1" && w2.s2?.[0]?.id === "a2" && Object.values(w2).flat().length === 2);
  ok("見張り: 周りに今合っている問題が無ければ無し", Object.keys(watchNeighbors([{ id: "s9", type: "Z", stage: "proposing", links: [] }], [W("x", "Y", "cost", [], true)])).length === 0);
  const C = (id: string, o: Partial<Candidate> = {}): Candidate => ({ id, type: "T", stage: "closing", links: [], why: [], flaky: false, reuse: false, draftEligible: true, lastOk: true, lastKinds: [], protectedPick: false, ...o });
  const cands = [C("f1", { lastOk: false }), C("g1"), C("g2")];
  const p1 = normalizePlan({ focus: [{ id: "f1", role: "fix", reps: 1, model: "pro", stage: "brain" }] }, { candidates: cands, capUsd: 1, flashOkTypes: ["T"], unit: UNIT_USD }, { draftChange: false, watch: { f1: [{ id: "g1", why: "見張り（同じ型）" }, { id: "g2", why: "見張り" }] } });
  ok("釣り合い: 司令塔が見張りを付けない重点に、周りの見張りを1つ足す（flash にしてよい型は flash）", p1.focus.some((x) => x.id === "g1" && x.role === "guard" && x.model === "flash") && !p1.focus.some((x) => x.id === "g2"));
  const p2 = normalizePlan({ focus: [{ id: "f1", role: "fix" }, { id: "g2", role: "guard" }] }, { candidates: cands, capUsd: 1, flashOkTypes: [], unit: UNIT_USD }, { draftChange: false, watch: { f1: [{ id: "g1", why: "x" }, { id: "g2", why: "y" }] } });
  ok("釣り合い: もう周りの見張りがあれば足さない", p2.focus.filter((x) => x.role === "guard").map((x) => x.id).join() === "g2");
  const p3 = normalizePlan({ focus: [{ id: "f1", role: "fix" }] }, { candidates: cands, capUsd: 0.031, flashOkTypes: [], unit: UNIT_USD }, { draftChange: false, watch: { f1: [{ id: "g1", why: "x" }] } });
  ok("釣り合い: 上限に入らなければ見張りから削る（重点は残る）", p3.focus.map((x) => x.id).join() === "f1" && p3.dropped.some((d) => d.id === "g1"));
}

console.log(`exam-brain-like-line: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
