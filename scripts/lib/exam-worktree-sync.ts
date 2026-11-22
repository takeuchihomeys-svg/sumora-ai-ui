// 2026-11-22 作業員H（統括役・前と今のコードの版の一致）: 試験の依頼を流す前に、係の試験の作業ツリー（既定 exam-night）を origin/main に合わせる。
//   11/22 の ess-1122-* は、今の回が exam-night（origin/main より最大12個古い）、外れた問題の前が今の main（cd3eaab）で、前と今のコードが違った
//   （q351 が3組全部で 前2/3→今0/2）。依頼を1本ずつ流すので、流す前に合わせても他の依頼にぶつからない。
//   ・合わせるのは係の試験の作業ツリーだけ（作業員の作業ツリーは触らない）
//   ・未コミットの変更（追跡しているファイル）があれば合わせずに止めて知らせる。memory/ の md だけの変更は早送りで合わさる時だけ合わせる
//   ・早送り（--ff-only）だけ。できなければ止めて知らせる。止める: EXAM_WORKTREE_SYNC=off
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type SyncDecision = { action: "skip"; why: string } | { action: "stop"; why: string } | { action: "merge"; behind: number; memoryOnlyDirty: boolean };

/** 純: status --porcelain の行と遅れの数から決める */
export function decideSync(i: { enabled: boolean; isExamWorktree: boolean; behind: number; porcelain: string[] }): SyncDecision {
  if (!i.enabled) return { action: "skip", why: "switch_off" };
  if (!i.isExamWorktree) return { action: "skip", why: "not_exam_worktree" };
  if (i.behind <= 0) return { action: "skip", why: "up_to_date" };
  const tracked = i.porcelain.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() && !l.startsWith("??"));
  const pathOf = (l: string) => l.slice(3).trim().replace(/^"|"$/g, "");
  const nonMemory = tracked.filter((l) => !/^memory\/[^/]+\.md$/.test(pathOf(l)));
  if (nonMemory.length) return { action: "stop", why: `未コミットの変更 ${nonMemory.length}件（${nonMemory.slice(0, 3).map(pathOf).join("・")}）` };
  return { action: "merge", behind: i.behind, memoryOnlyDirty: tracked.length > 0 };
}

/** 係の試験の作業ツリーか（名前で見る・既定 exam-night・EXAM_SYNC_WORKTREES=名前,名前） */
export function isExamWorktree(cwd: string, env: Record<string, string | undefined> = process.env): boolean {
  const names = String(env.EXAM_SYNC_WORKTREES ?? "exam-night").split(",").map((s) => s.trim()).filter(Boolean);
  return names.includes(basename(cwd.replace(/[\\/]+$/, "")));
}

/** 合わせる（副作用あり）。結果を1行で返す */
export function syncExamWorktree(cwd: string, env: Record<string, string | undefined> = process.env): { ok: boolean; line: string } {
  const g = (a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  const enabled = String(env.EXAM_WORKTREE_SYNC ?? "").trim().toLowerCase() !== "off";
  const isExam = isExamWorktree(cwd, env);
  if (!enabled || !isExam) return { ok: true, line: "" };
  try { g(["fetch", "-q", "origin", "main"]); } catch (e) { return { ok: true, line: `作業ツリーを合わせられない（fetch の失敗・今のまま流す）: ${String(e).slice(0, 120)}` }; }
  let behind = 0; try { behind = Number(g(["rev-list", "--count", "HEAD..origin/main"]).trim()) || 0; } catch { /* 数えられなければ合わせない */ }
  const porcelain = (() => { try { return g(["status", "--porcelain"]).split("\n"); } catch { return []; } })();
  const d = decideSync({ enabled, isExamWorktree: isExam, behind, porcelain });
  if (d.action === "skip") return { ok: true, line: "" };
  if (d.action === "stop") return { ok: false, line: `作業ツリーが origin/main より ${behind}個古いが、${d.why}＝合わせずに止める（前と今のコードの版がずれる）` };
  try { g(["merge", "--ff-only", "-q", "origin/main"]); } catch (e) { return { ok: false, line: `作業ツリーを早送りで合わせられない（${String(e).slice(0, 160)}）＝止める` }; }
  const head = (() => { try { return g(["rev-parse", "--short", "HEAD"]).trim(); } catch { return "?"; } })();
  return { ok: true, line: `作業ツリーを origin/main に合わせた（${behind}個進めて ${head}${d.memoryOnlyDirty ? "・memory/ の未コミットの md はそのまま" : ""}）` };
}
