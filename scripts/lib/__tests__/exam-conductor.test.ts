// 試験のブレインの司令塔・読み手（scripts/lib/exam-conductor.ts）の決め方の単体テスト（LLM も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-conductor.test.ts（全 PASS で exit 0）
import {
  classifyRow, problemMisses, buildMissMap, compareMissMaps, nextFocus, buildCoverage, linksOf, mapStageOf, normalizePlan, fitToCap, fallbackRaw,
  looseJson, buildConductorUser, parseDiffReading, parseTriage, machineJudge, mergeFlash, tierFinal, needPro, unitCost, deepseekUsd,
  freshFocus, freshProblemIds, pickAutoBase, parseRange,
  type ProblemLike, type RowLike, type Candidate, type FocusItem, type JudgeVec,
} from "../exam-conductor";
import { UNIT_USD } from "../exam-brain";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// ─── 問題の例（spec の形） ───
const pCheck: ProblemLike = { id: "q1", type: "AIXの種類", tags: [], accept: ["AIX:property_check_result"], asks: [{ q: "駐車場ありますか", route: "aix", point: "駐車場について" }], ng: ["物件オススメを出す"] };
const pPromise: ProblemLike = { id: "q2", type: "約束の返信を先に", tags: [], accept: ["2段:check"], asks: [{ q: "ペット大丈夫ですか", route: "promise", point: "管理会社に確認すると約束" }] };
const pPickup: ProblemLike = { id: "q3", type: "出し切り", tags: ["送った物件への反応"], accept: ["2段:pickup"], asks: [{ q: "肥後橋は外して", route: "promise", point: "肥後橋を除いて探す" }] };
const pReply: ProblemLike = { id: "q4", type: "一般的な事を保留しない", tags: ["初期費用"], accept: ["返信"], asks: [{ q: "敷金って何", route: "reply", point: "敷金の説明" }] };
const pView: ProblemLike = { id: "q5", type: "返信かAIXか", tags: ["内覧・日程"], accept: ["AIX:viewing_invite"], asks: [] };

// ─── 1. 線・地図の段 ───
ok("L1: 物件確認した が正解", linksOf(pCheck).includes("L1"));
ok("L2: 2段:check は約束の台帳の線", linksOf(pPromise).includes("L2"));
ok("L6: 2段:pickup は新着とピックアップの線", linksOf(pPickup).includes("L6"));
ok("L4: 送った物件への反応は条件の線", linksOf(pPickup).includes("L4"));
ok("地図: 内覧", mapStageOf(pView) === "viewing");
ok("地図: 初期費用", mapStageOf(pReply) === "cost");
ok("地図: 出し切り＝物件の提案", mapStageOf(pPickup) === "proposing");

// ─── 2. 外れを型に分ける ───
{
  const r: RowLike = { id: "q1", path: { code: "AIX:property_recommendation", ok: false }, score: { pass: false } };
  const m = classifyRow(pCheck, r);
  ok("道の外れ: AIX の種類の取り違え", m[0]?.kind === "AIXの種類の取り違え", JSON.stringify(m));
  ok("道の外れの働き＝決める", m[0]?.fn === "決める");
  const r2: RowLike = { id: "q1", path: { code: "AIX:property_check_result/mgmt_pet", ok: false }, score: { pass: false } };
  const pPick: ProblemLike = { ...pCheck, accept: ["AIX:property_check_result/mgmt_parking"] };
  ok("ピッカーの選び違い（同じボタン・細目違い）", classifyRow(pPick, r2)[0]?.kind === "ピッカーの選び違い", JSON.stringify(classifyRow(pPick, r2)));
  const r3: RowLike = { id: "q2", path: { code: "2段:check", ok: true }, score: { pass: false }, asks: [{ covered: false, route: true }] };
  ok("約束の中身の抜け", classifyRow(pPromise, r3)[0]?.kind === "約束の抜け");
  const r4: RowLike = { id: "q4", path: { code: "返信", ok: true }, score: { pass: false }, asks: [{ covered: false, route: false }] };
  ok("答え方の取り違え＝道の取り違え", classifyRow(pReply, r4)[0]?.kind === "道の取り違え");
  const r5: RowLike = { id: "q1", path: { code: "AIX:property_check_result", ok: true }, score: { pass: false }, asks: [{ covered: true, route: true }], ng: [{ violated: true }] };
  ok("言ってはいけない事", classifyRow(pCheck, r5).some((x) => x.kind === "言ってはいけない事"));
  const r6: RowLike = { id: "q4", path: { code: "返信", ok: true }, score: { pass: false }, asks: null };
  ok("判定の中身が無い合格✕＝中身は不明", classifyRow(pReply, r6)[0]?.kind === "合否の外れ（中身は不明）");
  const r7: RowLike = { id: "q4", path: { code: "返信", ok: true }, score: { pass: true }, asks: [{ covered: true }] };
  ok("合格は外れ0", classifyRow(pReply, r7).length === 0);
  const r8: RowLike = { id: "q4", path: { code: "返信", ok: true }, score: { pass: true }, draft: { code: "2段:check", ok: false, asks: [false] } };
  const m8 = classifyRow(pReply, r8);
  ok("下書きの外れは draft・働きは体で覚える", m8.length === 2 && m8.every((x) => x.part === "draft") && m8.some((x) => x.fn === "体で覚える"), JSON.stringify(m8));
  ok("失敗の行は数えない", classifyRow(pReply, { id: "q4", error: "x" }).length === 0);
  // 回を束ねる: 過半数の回に出た型だけ・1回だけは揺れ
  const pm = problemMisses(pPromise, [r3, r3, { id: "q2", path: { code: "2段:check", ok: true }, score: { pass: true }, asks: [{ covered: true }] }]);
  ok("過半数の回に出た型", pm.kinds.includes("約束の抜け") && !pm.ok);
  const pm2 = problemMisses(pPromise, [r3, { id: "q2", path: { code: "2段:check", ok: true }, score: { pass: true } }, { id: "q2", path: { code: "2段:check", ok: true }, score: { pass: true } }]);
  ok("1回だけの型は揺れ・問題は合格", pm2.ok && pm2.flakyKinds.includes("約束の抜け") && !pm2.kinds.length);
}

// ─── 3. 外れの型の地図・並べる・次の重点 ───
{
  const ps = [pCheck, pPromise, pPickup, pReply, pView];
  const rows: Record<string, RowLike[]> = {
    q1: [{ id: "q1", path: { code: "AIX:property_recommendation", ok: false }, score: { pass: false } }],
    q2: [{ id: "q2", path: { code: "2段:check", ok: true }, score: { pass: false }, asks: [{ covered: false, route: true }] }],
    q3: [{ id: "q3", path: { code: "2段:pickup", ok: true }, score: { pass: true } }],
    q4: [{ id: "q4", path: { code: "返信", ok: true }, score: { pass: true } }],
  };
  const m = buildMissMap(ps, (id) => (rows[id] ? { rows: rows[id] } : null));
  ok("地図: 答案のある問題 4・合格 2・無い 1", m.n === 4 && m.ok === 2 && m.noData.length === 1 && m.noData[0] === "q5");
  ok("地図: 型の数", m.byKind["AIXの種類の取り違え"] === 1 && m.byKind["約束の抜け"] === 1);
  ok("地図: 線の外れ", m.byLink.L1.miss === 1 && m.byLink.L2.miss >= 1);
  const rows2 = { ...rows, q1: [{ id: "q1", path: { code: "AIX:property_check_result", ok: true }, score: { pass: true } }], q4: [{ id: "q4", path: { code: "2段:check", ok: false }, score: { pass: false } }] };
  const m2 = buildMissMap(ps, (id) => (rows2[id as keyof typeof rows2] ? { rows: rows2[id as keyof typeof rows2] } : null));
  const c = compareMissMaps(m, m2);
  ok("並べる: 直った q1・壊れた q4", c.fixed.includes("q1") && c.broke.includes("q4"), JSON.stringify(c));
  const nf = nextFocus(m2, c);
  ok("次の重点: 壊れた問題が先頭", nf[0]?.id === "q4" && /退行/.test(nf[0].why));
  ok("前が無い時も並べられる", compareMissMaps(null, m).kinds.length > 0);
}

// ─── 4. 試験の地図（覆い） ───
{
  const cov = buildCoverage([pCheck, pPromise, pPickup, pReply, pView], [{ id: "g1", asks: [{ pickers: ["property_check_result/条件:mgmt_proxy"] }, { receive: "thanks" }] }]);
  ok("覆い: 代理契約のピッカーは1", cov.picker.find((p) => p.key.endsWith("mgmt_proxy"))?.n === 1);
  ok("覆い: 駐車場のピッカーは空き", cov.picker.find((p) => p.key.endsWith("mgmt_parking"))?.n === 0);
  ok("覆い: 空きに足し方の案", cov.holes.length > 0 && cov.holes.every((h) => h.add.length > 5));
  ok("覆い: L5（2通目）は空き", cov.link.find((l) => l.link === "L5")?.n === 0 && cov.holes.some((h) => h.where.includes("L5")));
  ok("覆い: 受け止めはパーツの正解で数える", cov.kind.find((k) => k.kind === "受け止めの抜け")?.measurable === 1);
}

// ─── 5. 司令塔の答えを整える・上限 ───
const cand = (id: string, o: Partial<Candidate> = {}): Candidate => ({ id, type: "AIXの種類", stage: "proposing", links: [], why: ["差分の言葉に近い（0.61）"], flaky: false, reuse: false, draftEligible: true, lastOk: true, lastKinds: [], protectedPick: false, ...o });
{
  const cands = [cand("q1"), cand("q2", { protectedPick: true, why: ["竹内さんのお手本（必ず）"] }), cand("q3", { draftEligible: false }), cand("q4", { type: "待って・閉じる" })];
  const raw = looseJson('前置き ```json\n{"focus":[{"id":"q1","role":"fix","stage":"draft","reps":5,"model":"flash","why":"直した所"},{"id":"q3","role":"guard","stage":"draft","reps":1,"model":"pro"},{"id":"q9","role":"fix"},{"id":"q4","role":"guard","model":"flash"}],"judge":"tier","claude_final":true,"claude_why":"最終チェック","note":"x",}\n```');
  ok("寛容な JSON（前置き・```・末尾のカンマ）", !!raw && Array.isArray(raw.focus));
  const pl = normalizePlan(raw, { candidates: cands, capUsd: 10, flashOkTypes: ["待って・閉じる"], unit: UNIT_USD }, { draftChange: true });
  const f = new Map(pl.focus.map((x) => [x.id, x]));
  ok("reps は 3 まで", f.get("q1")?.reps === 3);
  ok("flash は確かめた型だけ（AIXの種類→pro・待って・閉じる→flash）", f.get("q1")?.model === "pro" && f.get("q4")?.model === "flash");
  ok("下書き不可の問題は brain", f.get("q3")?.stage === "brain");
  ok("候補に無い id は捨てる", !f.has("q9") && pl.dropped.some((d) => d.id === "q9"));
  ok("守る問題は足す", f.get("q2")?.role === "fix");
  ok("判定の段は allowTier の時だけ", pl.judge === "pro" && pl.judgeAdvice === "tier");
  ok("判定の段（allowTier）", normalizePlan(raw, { candidates: cands, capUsd: 10, flashOkTypes: [], unit: UNIT_USD }, { draftChange: true, allowTier: true }).judge === "tier");
  ok("Claude の確かめの要否", pl.claudeFinal === true && pl.source === "pro");
  // 上限: 見張りの回→重点の回→見張りを削る→守らない重点を削る（守る問題は残す）
  const focus: FocusItem[] = [
    { id: "q1", role: "fix", stage: "draft", reps: 3, model: "pro", why: "" }, { id: "q2", role: "fix", stage: "brain", reps: 1, model: "pro", why: "" },
    { id: "q3", role: "guard", stage: "brain", reps: 2, model: "pro", why: "" }, { id: "q4", role: "guard", stage: "brain", reps: 1, model: "pro", why: "" },
  ];
  const byId = new Map(cands.map((c) => [c.id, c]));
  const total = focus.reduce((s, x) => s + unitCost(x), 0);
  ok("1問の値段", Math.abs(unitCost({ stage: "draft", reps: 3, model: "pro" }) - (UNIT_USD.brain + UNIT_USD.draftExtra) * 3) < 1e-9);
  const big = fitToCap(focus, 10, UNIT_USD, byId);
  ok("上限に収まる時はそのまま", big.focus.length === 4 && Math.abs(big.est - total) < 1e-9);
  const small = fitToCap(focus, 0.08, UNIT_USD, byId);
  ok("小さな上限: 収まる・守る問題 q2 は残る", small.est <= 0.08 + 1e-9 && small.focus.some((x) => x.id === "q2"), JSON.stringify(small));
  ok("小さな上限: 見張りから削る", small.dropped[0]?.id === "q4" || small.dropped[0]?.id === "q3");
  const zero = fitToCap(focus, 0, UNIT_USD, byId);
  ok("上限0でも守る問題だけは残す（守る線）", zero.focus.length === 1 && zero.focus[0].id === "q2");
  ok("使い回せる1回の問題は0円", fitToCap([{ id: "q1", role: "fix", stage: "brain", reps: 1, model: "pro", why: "" }], 1, UNIT_USD, new Map([["q1", cand("q1", { reuse: true })]])).est === 0);
  // 司令塔が答えない時
  const fb = normalizePlan(null, { candidates: cands, capUsd: 1, flashOkTypes: [], unit: UNIT_USD }, { draftChange: false });
  ok("答えが無い時は決まった順の代わり（source=fallback）", fb.source === "fallback" && fb.focus.some((x) => x.id === "q2"));
  ok("fallbackRaw は候補の先頭から", (fallbackRaw(cands, 2).focus as unknown[]).length === 2);
  const u = buildConductorUser({ change: { cls: "brain", files: [{ file: "app/lib/brain-core.ts", cls: "brain" }], kbIds: ["98bca000"], commits: ["直した"], reading: null }, missTop: [{ kind: "約束の抜け", n: 3 }], linkMiss: [{ link: "L1", label: "x", n: 2, miss: 1 }], candidates: cands, capUsd: 0.5, unit: UNIT_USD, flashOkTypes: [], prevFocus: [] });
  ok("司令塔の材料に候補と上限", u.includes("q2|") && u.includes("capUsd=0.50") && u.includes("98bca000"));
}

// ─── 6. 読み手の答えを読む ───
{
  const d = parseDiffReading('{"effects":[{"what":"ピッカーの材料を足した","files":["app/lib/brain-core.ts"]}],"kinds":["ピッカーの選び違い","嘘の型"],"links":["L1","L9"],"stages":["proposing"],"query":"駐車場 確認 ピッカー"}');
  ok("差分の読み: 知らない型・線は捨てる", !!d && d.kinds.length === 1 && d.links.length === 1 && d.stages[0] === "proposing" && d.query.includes("駐車場"));
  ok("差分の読み: 読めない時は null", parseDiffReading("読めません") === null);
  const t = parseTriage('{"items":[{"id":"q1","kind":"質問の答えの抜け","link":"L2","missing":["駐車場の有無"]},{"id":"qx","kind":"質問の答えの抜け"},{"id":"q2","kind":"なにか"}]}', ["q1", "q2"]);
  ok("振り分け: 頼んだ id と知っている型だけ", t.length === 1 && t[0].link === "L2" && t[0].missing[0] === "駐車場の有無");
}

// ─── 7. 判定の段（機械 → flash 2回 → 割れた時だけ pro） ───
{
  const mj = machineJudge([{ route: "aix" }, { route: "reply" }, { route: "aix", routes: ["promise"] }], { reply_mode: "reply", action: "" });
  ok("機械: AIX だけの依頼で答案に AIX 無し＝✕", mj.asks[0] === false && mj.route[0] === false);
  ok("機械: 返信の依頼・他の答え方もある依頼は LLM に回す", mj.asks[1] === null && mj.asks[2] === null);
  ok("機械: 答案に AIX があれば決めない", machineJudge([{ route: "aix" }], { action: "property_check_result" }).asks[0] === null);
  const a: JudgeVec = { asks: [false, true, true], route: [false, true, true], ng: [false], rawPath: "返信" };
  const b: JudgeVec = { asks: [true, true, false], route: [true, true, true], ng: [false], rawPath: "返信" };
  const fm = mergeFlash(a, b);
  ok("flash の割れ: 依頼1と3", fm.splitAsks.join(",") === "0,2" && !fm.splitNg.length && !fm.splitRaw);
  ok("pro を呼ぶ（機械で決まらない割れがある）", needPro(mj, fm));
  const pro: JudgeVec = { asks: [true, true, true], route: [true, true, true], ng: [true], rawPath: "2段:check" };
  const fin = tierFinal(mj, fm, pro);
  ok("最後: 依頼1は機械（✕）・依頼2は flash・依頼3は pro", fin.asks[0] === false && fin.asks[1] === true && fin.asks[2] === true && fin.by.machine === 1 && fin.by.pro === 1, JSON.stringify(fin));
  ok("最後: 割れない言ってはいけない事は flash", fin.ng[0] === false);
  const same = mergeFlash(a, a);
  ok("割れが無い時は pro を呼ばない", !needPro(machineJudge([{ route: "reply" }, { route: "reply" }, { route: "reply" }], {}), same));
  ok("機械で決まった割れだけなら pro を呼ばない", !needPro({ asks: [false, null, null], route: [false, null, null] }, mergeFlash(a, { ...a, asks: [true, true, true], route: [true, true, true] })));
}

// ─── 8. 費用 ───
// ─── 6. 新しい問題（答案なし）は司令塔の前に決まった計算で入れる（2026-10-20） ───
{
  const ps: ProblemLike[] = [pCheck, pPromise, { ...pReply, id: "q175" }, { ...pView, id: "q176" }];
  const answered = new Set(["q1", "q2"]);
  const ids = freshProblemIds(ps, (p) => answered.has(p.id));
  ok("新しい問題＝main の答案が1つも無い問題（spec の順）", JSON.stringify(ids) === JSON.stringify(["q175", "q176"]), JSON.stringify(ids));
  const items = [{ id: "q175", type: "一般的な事を保留しない" }, { id: "q176", type: "返信かAIXか" }];
  const fr = freshFocus(items, { flashOkTypes: ["返信かAIXか"], budgetUsd: 10 });
  ok("新しい問題: 1回・ブレインだけ", fr.focus.length === 2 && fr.focus.every((x) => x.reps === 1 && x.stage === "brain"));
  ok("新しい問題: flash にしてよい型は flash・他は pro", fr.focus.find((x) => x.id === "q176")?.model === "flash" && fr.focus.find((x) => x.id === "q175")?.model === "pro");
  ok("新しい問題: 見込み", Math.abs(fr.est - (unitCost({ stage: "brain", reps: 1, model: "pro" }) + unitCost({ stage: "brain", reps: 1, model: "flash" }))) < 1e-9);
  const one = unitCost({ stage: "brain", reps: 1, model: "pro" });
  const tight = freshFocus(items, { flashOkTypes: [], budgetUsd: one * 1.5 });
  ok("1日の上限: 収まる分だけ・後ろから削る", tight.focus.length === 1 && tight.focus[0].id === "q175" && tight.dropped[0]?.id === "q176" && /1日の上限/.test(tight.dropped[0].why), JSON.stringify(tight));
  ok("1日の上限の残り 0 なら入れない", freshFocus(items, { flashOkTypes: [], budgetUsd: 0 }).focus.length === 0);
  const chosen = new Map<string, FocusItem>([["q175", { id: "q175", role: "fix", stage: "draft", reps: 2, model: "pro", why: "直した所" }]]);
  const ch = freshFocus(items, { flashOkTypes: [], budgetUsd: 10, chosen });
  ok("司令塔が選んだ新しい問題はその回数・段を使う", ch.focus[0].reps === 2 && ch.focus[0].stage === "draft" && ch.focus[0].why.startsWith("新しい問題"));
  const chTight = freshFocus(items.slice(0, 1), { flashOkTypes: [], budgetUsd: one, chosen });
  ok("上限が足りない時は回を1・ブレインに落として残す", chTight.focus.length === 1 && chTight.focus[0].reps === 1 && chTight.focus[0].stage === "brain");
  // normalizePlan: 司令塔の答えに無くても入る・この実行の上限（capUsd）ではなく 1日の上限の残りに収める
  const cands = [cand("q1"), cand("q175", { type: "一般的な事を保留しない" })];
  const raw = { focus: [{ id: "q1", role: "fix", stage: "brain", reps: 1, model: "pro" }, { id: "q175", role: "guard", stage: "brain", reps: 3, model: "pro" }] };
  const pl = normalizePlan(raw, { candidates: cands, capUsd: one, flashOkTypes: ["返信かAIXか"], unit: UNIT_USD }, { draftChange: false, fresh: { items, dailyLeftUsd: 10 } });
  ok("normalizePlan: 新しい問題を別に入れる（fresh）", JSON.stringify(pl.fresh) === JSON.stringify(["q175", "q176"]) && pl.focus.some((x) => x.id === "q176") && pl.focus.some((x) => x.id === "q1"), JSON.stringify(pl));
  ok("normalizePlan: 新しい問題は実行の上限で削らない（1日の上限の残りまで）", pl.estUsd > one && !pl.dropped.some((d) => d.id === "q176"));
  ok("normalizePlan: 司令塔が選んだ新しい問題の回数を使う", pl.focus.find((x) => x.id === "q175")?.reps === 3);
  const pl2 = normalizePlan(null, { candidates: cands, capUsd: 1, flashOkTypes: [], unit: UNIT_USD }, { draftChange: false, fresh: { items, dailyLeftUsd: one } });
  ok("normalizePlan: 1日の上限の残りが少ない → 他の重点の見込みを引いた残りで入れる", pl2.focus.filter((x) => (pl2.fresh ?? []).includes(x.id)).length <= 1 && pl2.dropped.some((d) => /新しい問題/.test(d.why)), JSON.stringify(pl2));
  const pl3 = normalizePlan(null, { candidates: cands, capUsd: 1, flashOkTypes: [], unit: UNIT_USD }, { draftChange: false, fresh: { items, dailyLeftUsd: null } });
  ok("normalizePlan: 1日の上限なし → 全部入る", (pl3.fresh ?? []).length === 2);
  ok("normalizePlan: fresh を渡さない時は今まで通り（fresh の欄なし）", normalizePlan(raw, { candidates: cands, capUsd: 1, flashOkTypes: [], unit: UNIT_USD }, { draftChange: false }).fresh === undefined);
}
// ─── 7. 直した中身の起点・--range の形（2026-10-20） ───
{
  const anc = new Set(["aaa", "ccc"]);
  const b = pickAutoBase([
    { commit: "ccc", at: "2026-10-19T00:00:00Z", why: "c", group: "conductor" },
    { commit: "bbb", at: "2026-10-20T00:00:00Z", why: "b", group: "warm-main" },
    { commit: "aaa", at: "2026-10-18T00:00:00Z", why: "a", group: "warm-main" },
  ], (c) => anc.has(c));
  ok("起点: warm-main の中で HEAD の祖先の一番新しい物（HEAD 自身・別の枝は飛ばす）", b?.commit === "aaa", JSON.stringify(b));
  const b2 = pickAutoBase([{ commit: "bbb", at: "2026-10-20T00:00:00Z", why: "b", group: "warm-main" }, { commit: "ccc", at: "2026-10-19T00:00:00Z", why: "c", group: "conductor" }], (c) => anc.has(c));
  ok("起点: warm-main が無ければ前の司令塔の結果", b2?.commit === "ccc");
  ok("起点: どれも無ければ null（今まで通り作業ツリーの差）", pickAutoBase([], () => true) === null);
  const r = parseRange("e5f3c182..origin/main");
  ok("--range の形", r.from === "e5f3c182" && r.to === "origin/main");
  let threw = ""; try { parseRange("e5f3c182"); } catch (e) { threw = String(e); }
  ok("--range の形が違う → 分かる言葉で止める", /<a>..<b>/.test(threw));
}

ok("DeepSeek の値段（pro・2倍）", Math.abs(deepseekUsd("deepseek-v4-pro", { cacheHit: 0, cacheMiss: 1_000_000, output: 0 }, true) - 1.32) < 1e-9);
ok("DeepSeek の値段（flash）", Math.abs(deepseekUsd("deepseek-flash", { cacheHit: 1_000_000, cacheMiss: 0, output: 1_000_000 }, false) - 0.603) < 1e-9);

console.log(`exam-conductor: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
