// 係の試験の作業ツリーを流す前に origin/main に合わせる（scripts/lib/exam-worktree-sync.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-worktree-sync.test.ts（全 PASS で exit 0）
import { decideSync, isExamWorktree } from "../exam-worktree-sync";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const base = { enabled: true, isExamWorktree: true, behind: 12, porcelain: [] as string[] };
ok("遅れていて変更なし→合わせる", decideSync(base).action === "merge");
ok("遅れていない→何もしない", decideSync({ ...base, behind: 0 }).action === "skip");
ok("止めるスイッチ・試験の作業ツリーでない→何もしない", decideSync({ ...base, enabled: false }).action === "skip" && decideSync({ ...base, isExamWorktree: false }).action === "skip");
ok("未追跡のファイルだけ→合わせる", decideSync({ ...base, porcelain: ["?? scripts/brain-exam/gate-excluded.json", ""] }).action === "merge");
const mem = decideSync({ ...base, porcelain: [" M memory/rules_digest_review.md"] });
ok("memory/ の md だけの変更→合わせる（早送りで合わさる時だけ）", mem.action === "merge" && (mem as { memoryOnlyDirty: boolean }).memoryOnlyDirty);
const st = decideSync({ ...base, porcelain: [" M memory/rules_digest_review.md", " M scripts/brain-exam.ts"] });
ok("コードの未コミットの変更→止める", st.action === "stop" && /scripts\/brain-exam\.ts/.test((st as { why: string }).why), st);
ok("memory/ の下の深い所は止める", decideSync({ ...base, porcelain: [" M memory/sub/x.md"] }).action === "stop");
ok("試験の作業ツリーの名前", isExamWorktree("C:/x/.claude/worktrees/exam-night", {}) && !isExamWorktree("C:/x/.claude/worktrees/k2-apr-1120", {}) && isExamWorktree("C:/x/wt-a/", { EXAM_SYNC_WORKTREES: "wt-a" }));
console.log(`exam-worktree-sync: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
