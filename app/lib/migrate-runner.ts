// app/lib/migrate-runner.ts — migrate-schema の文をまとめて流す（2026-10-18 弱い所A-1）
//
// 旧: 約1000文を exec_sql で1文ずつ（1回 約180ms の往復＋重い文）→ 毎晩 maxDuration 300秒に届き、後ろの文が流れていなかった
//   （10/17 の夜は 720番目の llm_usage_logs の索引の文で打ち切り＝後ろの約270文が流れていない・postgres のログで確かめた）。
// 新: 文を batchSize 個ずつつないで1回の exec_sql に渡す（exec_sql は EXECUTE sql＝複数の文を流せ、1回＝1つのトランザクション）。
//   まとまりが失敗したら（どれか1文の失敗でまとまり全体が戻る）そのまとまりだけ1文ずつ流し直す＝旧と同じ結果になる。
//   - -- @atomic-begin〜end（splitSql が1つの要素にしたもの）は分けない（まとまりの中でも・流し直しでも1回の呼び出し）。
//   - まとまりの先頭で SET LOCAL lock_timeout を短くする（多くの表の鍵を持ったまま待って画面の読み書きを止めない。待ったら流し直しへ）。
//   - 文の順は変えない（関数の SET probes を付け直す DO ブロックは match_* の定義より後ろ・同じ呼び出しで vector を読み込む＝94cc340a）。
//   - 締め切り（deadlineAt）を過ぎたら新しい呼び出しをしない＝どこで止まったかを stoppedAt に残す。
// 旧に戻す: batchSize=1（MIGRATE_BATCH=off）＝1文ずつ・SET LOCAL なし。

import { createHash } from "crypto";

export type ExecSql = (sql: string) => Promise<{ error: string | null }>;

export interface MigrateRunError { index: number; head: string; message: string }
export interface MigrateRunResult {
  total: number;          // 流す対象の文の数（コメントだけの塊を除く）
  calls: number;          // exec_sql の呼び出し回数
  batches: number;        // まとまりの数
  batchFailures: number;  // 失敗して1文ずつ流し直したまとまりの数
  errors: MigrateRunError[];
  stoppedAt: number | null; // 締め切りで止めた時、まだ流していない最初の文の番号（null＝最後まで流した）
  completed: boolean;
  ms: number;
}

/** 行頭が -- の行と空行を落とした中身（コメントだけの塊を見分ける・文の先頭を報告に出す） */
function stripCommentLines(s: string): string {
  return s.split("\n").filter((l) => l.trim() && !/^\s*--/.test(l)).join("\n");
}

/** コメントだけの塊（splitSql が「-- … ;」で区切った物）か */
export function isCommentOnly(stmt: string): boolean {
  return stripCommentLines(stmt).trim() === "";
}

/** 1文を exec_sql に渡せる形に: 末尾のコメント行を落として ; で終わらせる（つないだ時に次の文がコメントに飲まれない） */
export function terminate(stmt: string): string {
  const lines = stmt.replace(/\s+$/, "").split("\n");
  while (lines.length && /^\s*(--.*)?$/.test(lines[lines.length - 1])) lines.pop();
  const body = lines.join("\n").replace(/\s+$/, "");
  return body.endsWith(";") ? body : body + ";";
}

export function stmtHead(stmt: string): string {
  return stripCommentLines(stmt).replace(/\s+/g, " ").trim().slice(0, 120);
}

/** SQL 全体の指紋（変わった夜だけ流す判定に使う） */
export function sqlFingerprint(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

/** まとまり1つ分の SQL（先頭で lock_timeout を短く） */
export function buildBatchSql(stmts: string[], lockTimeout: string | null): string {
  const head = lockTimeout ? `SET LOCAL lock_timeout = '${lockTimeout.replace(/'/g, "")}';\n` : "";
  return head + stmts.map(terminate).join("\n");
}

export async function runStatementsBatched(
  statements: string[],
  exec: ExecSql,
  opts: { batchSize?: number; lockTimeout?: string | null; deadlineAt?: number; now?: () => number } = {},
): Promise<MigrateRunResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 50));
  const lockTimeout = batchSize > 1 ? (opts.lockTimeout === undefined ? "3s" : opts.lockTimeout) : null;
  const items = statements.map((s, index) => ({ s, index })).filter((x) => !isCommentOnly(x.s));
  const res: MigrateRunResult = { total: items.length, calls: 0, batches: 0, batchFailures: 0, errors: [], stoppedAt: null, completed: false, ms: 0 };
  const late = () => opts.deadlineAt !== undefined && now() >= opts.deadlineAt;
  const call = async (sql: string): Promise<string | null> => {
    res.calls++;
    try { return (await exec(sql)).error; } catch (e) { return e instanceof Error ? e.message : String(e); }
  };

  for (let i = 0; i < items.length; i += batchSize) {
    if (late()) { res.stoppedAt = items[i].index; break; }
    const group = items.slice(i, i + batchSize);
    res.batches++;
    if (group.length > 1) {
      const err = await call(buildBatchSql(group.map((g) => g.s), lockTimeout));
      if (!err) continue;
      res.batchFailures++;
    }
    // 1文ずつ（旧と同じ流し方）
    for (let j = 0; j < group.length; j++) {
      if (group.length > 1 && late()) { res.stoppedAt = group[j].index; break; }
      const g = group[j];
      const err = await call(terminate(g.s));
      if (err) res.errors.push({ index: g.index, head: stmtHead(g.s), message: err.slice(0, 300) });
    }
    if (res.stoppedAt !== null) break;
  }
  res.completed = res.stoppedAt === null;
  res.ms = now() - t0;
  return res;
}

/** 変わっていない夜は流さないか（前回の最後まで流した記録と指紋が同じ・間が maxAgeDays 以内） */
export function shouldSkipUnchanged(
  last: { fingerprint?: unknown; completed?: unknown; started_at?: string | null } | null,
  fingerprint: string,
  nowMs: number,
  maxAgeDays: number,
): boolean {
  if (!last || last.completed !== true || last.fingerprint !== fingerprint || !last.started_at) return false;
  const age = nowMs - new Date(last.started_at).getTime();
  return Number.isFinite(age) && age >= 0 && age < maxAgeDays * 86400_000;
}
