// 試験のブレインを LINE のブレインの組み方に寄せた所（2026-10-20）の単体テスト（LLM も DB も使わない）
//   COST① main の答えの持ち越し・取り置きの予約／COST② 自信で回数を決める／COST③ flash の選び／QUALITY⑤〜⑧ の決まった所
// 実行: npx tsx scripts/lib/__tests__/exam-brain-like-line.test.ts（全 PASS で exit 0）
import { examStageKeysOf, type FileMap } from "../exam-scope";
import { findCarryOver, relevantStageOf, siblingDirs, type BaselineFile } from "../brain-exam-baseline";
import { warmDecision, warmLimit } from "../exam-brain";

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

console.log(`exam-brain-like-line: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
