// 2026-10-16 試験の RAG の選び方・キャッシュの並べ方・比べる相手の期限・設計知見との連動（exam-rag / exam-rag-store / exam-kb-rules / brain-exam-baseline）
// 実行: npx tsx scripts/lib/__tests__/exam-rag.test.ts（自己完結・LLM も DB も埋め込みも使わない。全 PASS で exit 0）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "exam-rag-test-"));
process.env.EXAM_CACHE_DIR = tmp; // 置き場は試しの場所（共有の置き場を汚さない）

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

(async () => {
  const R = await import("../exam-rag");
  const S = await import("../exam-rag-store");
  const K = await import("../exam-kb-rules");
  const B = await import("../brain-exam-baseline");
  const run = await import("../exam-rag-run");

  // ─── 札 ───
  const mask = (s: string) => s.replace(/山田/g, "YUMA").replace(/090-\d{4}-\d{4}/g, "（電話番号）");
  const card = R.cardOfProblem({ id: "q1", type: "出し切り", sub: "s", tags: ["お手本"], customer: "山田です 090-1234-5678 もう少し探して", staffText: "山田さん 新着を随時お送りします", accept: ["返信"], conv: "22b2511e-034e-44f4-8c10-b737716a3284", context: [{ s: "staff", t: "山田さん 物件です" }, { s: "customer", t: "x" }] }, { specHash: "h", stage: "draft", mask, files: ["a.ts"], actions: ["brain_full", "brain_full"] });
  ok("札の言葉・正解は伏せた物", !/山田|090-/.test(card.words + card.answer), card.words + card.answer);
  ok("会話 id は入れない（hash）", !JSON.stringify(card).includes("22b2511e") && card.convHash.length === 16);
  ok("お手本の札は source=takeuchi_send", card.source === "takeuchi_send");
  ok("名札は重ねない", card.parts.actions.join() === "brain_full");
  ok("直前のこちらの送信も言葉に入る", card.words.includes("（直前のこちら）"));

  // ─── 選び方 ───
  const v = (x: number, y: number) => [x, y, 0];
  const mk = (id: string, e: number[] | null, stage: "brain" | "draft" = "brain") => ({ ...card, id, stage, embedding: e });
  const cards = [mk("a", v(1, 0)), mk("b", v(0.9, 0.1)), mk("c", v(0, 1)), mk("d", v(0.7, 0.7), "draft"), mk("e", v(-1, 0))];
  const base = { cards, queryVec: v(1, 0), changeClass: "brain" as const, failedBefore: new Set<string>(), fresh: new Set<string>(), links: {}, changedKb: [], kbHits: [], topN: 2 };
  let r = R.selectProblems(base);
  ok("上位 N（近い順）", r.mode === "rag" && r.picked.map((p) => p.id).join() === "a,b", JSON.stringify(r.picked));
  ok("選んだ理由を持つ", r.picked[0].why[0].includes("差分の言葉に近い"));
  r = R.selectProblems({ ...base, allReason: "scripts/brain-exam.ts（試験の道具）" });
  ok("試験の道具を直したら全部", r.mode === "all" && r.picked.length === 5);
  r = R.selectProblems({ ...base, queryVec: null });
  ok("差分の埋め込みが無ければ全部", r.mode === "all");
  r = R.selectProblems({ ...base, cards: cards.map((c, k) => (k < 3 ? { ...c, embedding: null } : c)) });
  ok("埋め込みの無い問題が半分を超えたら全部", r.mode === "all");
  r = R.selectProblems({ ...base, failedBefore: new Set(["e"]), fresh: new Set(["c"]) });
  ok("前に落ちた・新しい問題は必ず入る", ["a", "b", "c", "e"].every((id) => r.picked.some((p) => p.id === id)) && r.picked.find((p) => p.id === "e")!.must);
  const links = { c: [{ kbId: "11111111-aaaa", kind: "fixed" as const, score: 1, at: "x" }], e: [{ kbId: "22222222-bbbb", kind: "auto" as const, score: 0.5, at: "x" }] };
  r = R.selectProblems({ ...base, links, changedKb: [{ id: "11111111-aaaa", kind: "changed" }], kbHits: [{ id: "22222222-bbbb", score: 0.6, title: "題" }] });
  ok("変えた知見に紐付く問題が入る", r.picked.find((p) => p.id === "c")?.why.some((w) => w.includes("変えた")) === true);
  ok("差分で当たった知見に紐付く問題が入る", r.picked.find((p) => p.id === "e")?.why.some((w) => w.includes("当たった知見")) === true);
  r = R.selectProblems({ ...base, kbNearProblems: { "33333333-cccc": [{ id: "c", sim: 0.5 }] } });
  ok("紐付けの無い新しい知見は近い問題を入れる", r.picked.some((p) => p.id === "c"));
  r = R.selectProblems({ ...base, changeClass: "draft" });
  ok("下書きだけの変更は下書きまでの問題だけ", r.picked.every((p) => p.id === "d"), JSON.stringify(r.picked));
  r = R.selectProblems({ ...base, changeClass: "none", failedBefore: new Set(["c"]) });
  ok("試験に効く変更なし → 必ず入れる問題だけ", r.picked.map((p) => p.id).join() === "c");
  r = R.selectProblems({ ...base, queryVec: v(0, -1), topN: 5 });
  ok("近さの下限未満は上位でも入れない", !r.picked.some((p) => p.id === "c"));

  r = R.selectProblems({ ...base, mentioned: ["c"] });
  ok("名指しされた問題は必ず入る", r.picked.find((p) => p.id === "c")?.why.includes("差分・言葉で名指し") === true);
  // 前に落ちた（道）: 表示の注を戻して正解と比べる
  ok("道: 左だけは AIX:左右 の外れ", run.pathFailedSig("AIX:property_send（左だけ）|✕", { accept: ["AIX:左右"] }) === true);
  ok("道: 左右は AIX:左右 の正解", run.pathFailedSig("AIX:property_send（左右）|○", { accept: ["AIX:左右"] }) === false);
  ok("道: 初回の注を外して 2段:pickup", run.pathFailedSig("2段:pickup（初回）|✕", { accept: ["2段:pickup"] }) === false);
  ok("道: 出し切りの決まりの正解でも合う", run.pathFailedSig("AIX:zenryoku_support|○", { accept: ["返信"], acceptWhen: { searchExhausted: ["AIX:zenryoku_support"] } }) === false);
  ok("道: 下書きの道の外れも落ちた", run.pathFailedSig("返信|✕|下書き=2段:check✕", { accept: ["返信"] }) === true);

  // ─── 知見の変化 ───
  ok("初回（控え無し）は変化なし", R.kbChanges(null, { a: "1" }).length === 0);
  const ch = R.kbChanges({ at: "", rows: { a: "1", b: "2", c: "3" } }, { a: "1", b: "9", d: "4" });
  ok("入れた・変えた・退役した", ch.map((x) => `${x.id}:${x.kind}`).sort().join() === "b:changed,c:retired,d:new", JSON.stringify(ch));

  // ─── 差分の言葉 ───
  const dq = R.diffQueryText("diff --git a/x b/x\n--- a/x\n+++ b/x\n+// 相場は根拠がある時だけ\n+const x = 1;\n-old line here\n", ["app/lib/x.ts"]);
  ok("差分の言葉: 日本語の行が先・ファイル名つき", dq.startsWith("直したファイル: app/lib/x.ts\n// 相場は根拠がある時だけ") && !dq.includes("+++"), dq);

  // ─── 並べ方（キャッシュ） ───
  const ps = [{ id: "q1", type: "A" }, { id: "q2", type: "B" }, { id: "q3", type: "A" }, { id: "q4", type: "C" }, { id: "q5", type: "B" }];
  const stage = (p: { id: string }) => (p.id === "q2" ? "draft" as const : "brain" as const);
  const pre: Record<string, string | null> = { q1: "P1", q3: "P2", q4: "P1", q5: null };
  const o1 = R.orderForCache(ps, { stageOf: stage, prefixOf: (id) => pre[id] ?? null });
  ok("並べ方: 段 → 前置き → 型（安定）", o1.map((p) => p.id).join() === "q1,q4,q5,q3,q2", o1.map((p) => p.id).join());
  ok("並べ方は並べ替えだけ（抜け・重なりなし）", [...o1].map((p) => p.id).sort().join() === ps.map((p) => p.id).sort().join());
  const shuffled = [ps[3], ps[0], ps[4], ps[2], ps[1]];
  const o2 = R.orderForCache(shuffled, { stageOf: stage, prefixOf: (id) => pre[id] ?? null });
  const contiguous = (o: typeof ps) => { const seen = new Set<string>(); let last = ""; for (const p of o) { const k = `${stage(p)}|${pre[p.id] ?? `型:${p.type}`}`; if (k !== last && seen.has(k)) return false; seen.add(k); last = k; } return true; };
  ok("同じ前置きは続けて流れる（入りの順が違っても）", contiguous(o1) && contiguous(o2));
  // 比べは問題 id で束ねる＝並べ替えで結果が変わらない（planBaseline は id ごと）
  const cached = new Map<string, import("../brain-exam-baseline").BaselineFile<{ rep: number }>>([["q1", { id: "q1", problemHash: "h1", commit: "c", config: { args: {}, env: {} }, savedAt: new Date().toISOString(), fromLabel: "l", rows: [{ rep: 1 }] }]]);
  const pl1 = B.planBaseline(ps.map((p) => ({ id: p.id, hash: p.id === "q1" ? "h1" : "x" })), cached, 1);
  const pl2 = B.planBaseline(o2.map((p) => ({ id: p.id, hash: p.id === "q1" ? "h1" : "x" })), cached, 1);
  ok("並べ替えても使い回し・回す問題は同じ", pl1.reuse.join() === pl2.reuse.join() && [...pl1.run].sort().join() === [...pl2.run].sort().join());

  const body = JSON.stringify({ system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "fixed", cache_control: {} }, { type: "text", text: "var1" }] }] });
  const body2 = JSON.stringify({ system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "fixed", cache_control: {} }, { type: "text", text: "var2" }] }] });
  ok("前置きの印: 固定の塊までが同じなら同じ印", R.prefixKeyOfBody(body) === R.prefixKeyOfBody(body2) && !!R.prefixKeyOfBody(body));
  ok("前置きの印: 壊れた本文は null", R.prefixKeyOfBody("{x") === null);

  // ─── 比べる相手の期限 ───
  const old = new Map(cached); old.set("q1", { ...cached.get("q1")!, savedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
  const pa = B.planBaseline([{ id: "q1", hash: "h1" }], old, 1, { maxAgeMs: 7 * 86_400_000 });
  ok("期限: 7日より古い取り置きは流し直す", pa.run.join() === "q1" && pa.expired.join() === "q1");
  ok("期限なし（旧の動き）は使い回す", B.planBaseline([{ id: "q1", hash: "h1" }], old, 1).reuse.join() === "q1");
  ok("期限の引数: 既定 7日・off・数", B.baselineMaxAgeMs(undefined, {}) === 7 * 86_400_000 && B.baselineMaxAgeMs("off", {}) === null && B.baselineMaxAgeMs(undefined, { EXAM_BASELINE_MAX_AGE_DAYS: "3" }) === 3 * 86_400_000 && B.baselineMaxAgeMs("0", {}) === null);
  ok("子に --select・期限を渡さない", B.childArgs(["--select=rag", "--select-n=5", "--baseline-max-age=3", "--link-kb=x", "--replay"]).join() === "--replay");

  // ─── 紐付け ───
  const merged = R.mergeAutoLinks([{ kbId: "k1", kind: "fixed", score: 1, at: "t" }, { kbId: "k2", kind: "auto", score: 0.4, at: "t" }], [{ kbId: "k1", kind: "auto", score: 0.9, at: "t" }, { kbId: "k3", kind: "auto", score: 0.5, at: "t" }]);
  ok("自動の候補を入れ替えても固定は残る", merged.map((l) => `${l.kbId}:${l.kind}`).join() === "k1:fixed,k3:auto");
  ok("落ちた時に出す知見は固定が先", R.topLinks([{ kbId: "a", kind: "auto", score: 0.9, at: "" }, { kbId: "b", kind: "fixed", score: 1, at: "" }])[0].kbId === "b");
  ok("固定の紐付けを足すと前の同じ知見を置き換える", R.addFixedLink([{ kbId: "k1", kind: "auto", score: 0.3, at: "" }], { kbId: "k1", score: 1, at: "" }).length === 1);

  // ─── 置き場（表が無い間は共有のファイル） ───
  const fakeSb = { from: () => ({ select: () => ({ limit: async () => ({ error: { message: "relation does not exist" } }) }) }) } as never;
  ok("表が無ければ共有のファイル", (await S.useDbStore(fakeSb)) === false);
  ok("置き場は EXAM_CACHE_DIR の下", S.CARDS_FILE.startsWith(tmp));
  await S.saveCards(fakeSb, [{ ...card, embedding: [1, 2], embeddingHash: "z" }]);
  const back = await S.loadCards(fakeSb);
  ok("札を書いて読める", back.q1?.embedding?.join() === "1,2");
  await S.updateLinks(fakeSb, (cur) => ({ ...cur, q1: [{ kbId: "k", kind: "auto", score: 0.5, at: "t" }] }));
  ok("紐付けを書いて読める", (await S.loadLinks(fakeSb)).q1?.[0].kbId === "k");
  run.recordFixedLinks(["q1"], ["title:まだ無い題"]);
  ok("直して通った紐付けは題で控える", S.readPendingLinks().some((x) => x.problemId === "q1" && x.kbRef === "title:まだ無い題"));
  ok("近い問題: 下限と上位", S.nearProblemsOf([1, 0, 0], cards as never, 2, 0.5).map((x) => x.id).join() === "a,b");

  // ─── 全部にする理由 ───
  ok("全部にする理由: 試験の道具", run.allReasonOf({ stage: "draft", cls: "both", base: "x", files: [{ file: "scripts/brain-exam.ts", cls: "both", why: "試験の道具・問題" }], note: "" })?.includes("brain-exam.ts") === true);
  ok("全部にしない: ブレインと下書きの両方が読むファイル", run.allReasonOf({ stage: "draft", cls: "both", base: "x", files: [{ file: "app/lib/x.ts", cls: "both", why: "ブレインと下書きの両方が読む" }], note: "" }) === null);
  ok("全部にする理由: 分かれ目が分からない", !!run.allReasonOf({ stage: "draft", cls: "both", base: null, files: [], note: "main との分かれ目が分からない → 安全側（両方）" }));

  // ─── 知見の決まりの採点 ───
  const ctx = { contextText: "梅田駅から1本の物件です。希望は四条畷", pcText: "{\"desired_area\":\"四条畷\"}" };
  ok("駅: 出どころにある駅は通す", K.checkKbRules("梅田駅まで1本です", ctx).length === 0);
  const h1 = K.checkKbRules("瓢箪山駅から近いお部屋です", ctx);
  ok("駅: 出どころに無い駅は違反（知見 015f2950）", h1.length === 1 && h1[0].kbId.startsWith("015f2950") && h1[0].why.includes("瓢箪山駅"), JSON.stringify(h1));
  ok("駅: 「最寄り駅」は駅の名前ではない", K.checkKbRules("最寄り駅から5分です", ctx).length === 0);
  ok("駅: 前の平仮名（近くの）は外す", K.checkKbRules("近くの梅田駅です", ctx).length === 0);
  const h2 = K.checkKbRules("相場より安い家賃管理費込65,500円です", ctx);
  ok("相場: 材料が無いのに相場と比べたら違反（知見 d94a966c）", h2.some((h) => h.kbId.startsWith("d94a966c")));
  ok("相場: 材料があれば通す", K.checkKbRules("相場より安いです", { ...ctx, contextText: "この辺りの相場は7万" }).length === 0);
  ok("決まりの採点の切り替え", K.kbRulesMode(undefined, {}) === "show" && K.kbRulesMode("score", {}) === "score" && K.kbRulesMode(undefined, { EXAM_KB_RULES: "off" }) === "off");

  rmSync(tmp, { recursive: true, force: true });
  console.log(`exam-rag: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
