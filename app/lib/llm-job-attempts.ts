// app/lib/llm-job-attempts.ts
// 定期処理（cron）の LLM 呼び出しで「失敗した物に印を付けず、次の実行でまた同じ物を送る」繰り返しを止める共通の記録
//
// 2026-09-14 竹内（API の漏れ調査）: 失敗時に処理済みの印を付けない cron が、同じ物を毎回・毎日・毎週送り直していた
//   （申込到達会話の学習: 7日で29回実行し毎回同じ会話で失敗／週次のナレッジ判定: 同じ200件／☆例文のナレッジ化: 同じ15件 等）。
//   失敗の原因が入力そのもの（壊れた文字・長すぎる会話）なら何度送っても失敗し、課金される失敗（出力切れ・529 の再試行）なら費用が漏れ続ける。
//   → 物ごとに失敗の回数を数え、上限（既定3回）で諦める。失敗でも成功でもない「処理したが保存する物が無かった」は done で印を付ける。
//   設計知見「失敗しても処理済みの印を付けない × 定期実行」の型。テーブル llm_job_attempts（migrate-schema）

// supabase は使う時に読み込む（純関数 isAttemptBlocked・attemptKey を環境変数なしで単体テストできるように）
async function db() {
  return (await import("@/app/lib/supabase")).supabase;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/** 長い文そのものを物の ID にする時の短い鍵（FNV-1a 32bit×2 で衝突を避ける） */
export function attemptKey(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export type AttemptRow = { item_id: string; attempts: number | null; done_at: string | null };

/** もう送らない物か（処理済み、または失敗が上限に達した） */
export function isAttemptBlocked(row: Pick<AttemptRow, "attempts" | "done_at"> | undefined, maxAttempts = DEFAULT_MAX_ATTEMPTS): boolean {
  if (!row) return false;
  if (row.done_at) return true;
  return (row.attempts ?? 0) >= maxAttempts;
}

/** ids のうち、もう送らない物の集合（DB が読めない時は空＝従来どおり全部送る） */
export async function loadBlockedItems(job: string, ids: string[], maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<Set<string>> {
  const blocked = new Set<string>();
  if (ids.length === 0) return blocked;
  const supabase = await db();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("llm_job_attempts")
      .select("item_id, attempts, done_at")
      .eq("job", job)
      .in("item_id", ids.slice(i, i + 200));
    if (error) { console.warn(`[llm-job-attempts] ${job} load failed:`, error.message); return new Set(); }
    for (const r of (data ?? []) as AttemptRow[]) if (isAttemptBlocked(r, maxAttempts)) blocked.add(r.item_id);
  }
  return blocked;
}

/** 失敗を1回数える（上限に達したらログに出す） */
export async function recordAttemptFailure(job: string, itemId: string, error: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<void> {
  const supabase = await db();
  const { data } = await supabase.from("llm_job_attempts").select("attempts").eq("job", job).eq("item_id", itemId).maybeSingle();
  const attempts = ((data as { attempts?: number | null } | null)?.attempts ?? 0) + 1;
  const { error: upErr } = await supabase.from("llm_job_attempts").upsert(
    { job, item_id: itemId, attempts, last_error: error.slice(0, 500), last_attempt_at: new Date().toISOString() },
    { onConflict: "job,item_id" },
  );
  if (upErr) console.warn(`[llm-job-attempts] ${job} record failed:`, upErr.message);
  if (attempts >= maxAttempts) {
    console.log(JSON.stringify({ tag: "llm-job:gave-up", job, itemId, attempts, error: error.slice(0, 200) }));
  }
}

/** 処理した（保存する物が無かった等も含む）ので、もう送らない */
export async function markAttemptDone(job: string, itemId: string): Promise<void> {
  const supabase = await db();
  const { error } = await supabase.from("llm_job_attempts").upsert(
    { job, item_id: itemId, done_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() },
    { onConflict: "job,item_id" },
  );
  if (error) console.warn(`[llm-job-attempts] ${job} done failed:`, error.message);
}
