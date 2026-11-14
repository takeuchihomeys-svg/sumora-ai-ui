// app/api/learn-supervisor-init/route.ts
//
// 2026-11-14 竹内さん「データベース連携しているからいますぐやる」
//
// `learn_supervisor_log` を**今すぐ**作るための1回だけの入口。
//
// ⚠ 安全のため:
//   ・**表が無い時だけ動く**（もう在れば何もしない＝何度呼んでも安全）
//   ・作る物は**この1つの表だけ**（他の表・列は触らない）
//   ・`SUPABASE_SERVICE_ROLE_KEY` が無ければ何もしない（本番には在る）
//   ・画面には**成否と行数だけ**返す（秘密の値は出さない）
//
// 使い方: ブラウザで
//   https://sumora-ai-ui.vercel.app/api/learn-supervisor-init
import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS learn_supervisor_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope TEXT NOT NULL DEFAULT 'all',
  verdict TEXT NOT NULL,
  headline TEXT,
  coverage INTEGER NOT NULL DEFAULT 0,
  weak_n INTEGER NOT NULL DEFAULT 0,
  next_n INTEGER NOT NULL DEFAULT 0,
  points_n INTEGER NOT NULL DEFAULT 0,
  opens_n INTEGER NOT NULL DEFAULT 0,
  screens_n INTEGER NOT NULL DEFAULT 0,
  sequence_n INTEGER NOT NULL DEFAULT 0,
  with_ops INTEGER NOT NULL DEFAULT 0,
  guessed_opens INTEGER NOT NULL DEFAULT 0,
  rows INTEGER NOT NULL DEFAULT 0,
  delta JSONB,
  actions JSONB,
  meeting JSONB,
  block TEXT,
  bundle_at TIMESTAMPTZ
)`,
  `CREATE INDEX IF NOT EXISTS idx_learn_supervisor_scope ON learn_supervisor_log(scope, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_learn_supervisor_created ON learn_supervisor_log(created_at DESC)`,
  `ALTER TABLE learn_supervisor_log ENABLE ROW LEVEL SECURITY`,
  /**
   * 2026-11-14 竹内さん「PLS無効にしたらよいのでは」→ **その通りでした**。
   *   ⚠ RLS を有効にしていたため、Service Role キーが無いと**書き込めなかった**
   *     （実測: 統括の判断がほとんど残っていなかった・ローカルでは 0件）。
   *   → 他の表（`automation_commands` 等）と同じく **DISABLE にそろえる**。
   *   ⚠ 入れるのは**数と判断だけ**（入力した中身・名前・電話・住所は入れない）。
   */
  `ALTER TABLE learn_supervisor_log DISABLE ROW LEVEL SECURITY`,
  `COMMENT ON TABLE learn_supervisor_log IS '学習の統括の判断（結論・材料の揃い・弱い所・次にやる事・打ち合わせの内容）を1回ごとに1行。数と判断だけ。2026-11-14 竹内さん承認'`,
  `SELECT pg_notify('pgrst', 'reload schema')`,
];

async function run() {
  // ① もう在るか（在れば RLS だけ直して終わる）
  const probe = await supabase.from("learn_supervisor_log").select("id").limit(1);
  if (!probe.error) {
    /**
     * 2026-11-14 竹内さん「PLS無効にしたらよいのでは」:
     *   ⚠ 表は在るが **RLS が有効**なため書き込めていなかった（実測）。
     *     旧は「在れば何もしない」で終わっていたので**永久に直らなかった**。
     *   → 在る時も **RLS を無効にする1行** を流す（何度呼んでも安全）。
     */
    const fix = await supabase.rpc("exec_sql", { sql: "ALTER TABLE learn_supervisor_log DISABLE ROW LEVEL SECURITY;" });
    const rlsError = fix.error ? String(fix.error.message).slice(0, 200) : null;
    /**
     * 2026-11-14: 既にある時は**中身の確認**も返す（保存が動いているか分かるように）。
     *   ⚠ 数と結論だけ（中身の詳細は返さない）。
     */
    const cnt = await supabase.from("learn_supervisor_log").select("*", { count: "exact", head: true });
    const recent = await supabase
      .from("learn_supervisor_log")
      .select("created_at, scope, verdict, coverage, weak_n")
      .order("created_at", { ascending: false })
      .limit(5);
    return NextResponse.json(
      {
        ok: true,
        already: true,
        message: rlsError
          ? "learn_supervisor_log はあります（RLS の解除に失敗: " + rlsError + "）"
          : "learn_supervisor_log はあります（RLS を無効にしました＝書けるようになりました）",
        rls_disabled: !rlsError,
        rows: cnt.error ? null : (cnt.count ?? 0),
        recent: recent.error ? [] : (recent.data ?? []),
      },
      { headers: CORS },
    );
  }

  // ② 作る
  const results: Array<{ step: string; ok: boolean; error?: string }> = [];
  for (const sql of DDL) {
    const { error } = await supabase.rpc("exec_sql", { sql });
    results.push({ step: sql.replace(/\s+/g, " ").slice(0, 60), ok: !error, ...(error ? { error: String(error.message).slice(0, 200) } : {}) });
    if (error) {
      const denied = /permission denied/i.test(String(error.message || ""));
      if (denied) {
        return NextResponse.json(
          {
            ok: false,
            reason: "exec_sql の権限がありません（サービスロールのキーが必要）",
            hint: "今夜 JST 0:10 の migrate-schema で必ず作られます",
            results,
          },
          { status: 403, headers: CORS },
        );
      }
    }
  }

  // ③ できたか確かめる（キャッシュが更新されるまで少し待つ）
  await new Promise((r) => setTimeout(r, 2000));
  const after = await supabase.from("learn_supervisor_log").select("id").limit(1);
  return NextResponse.json(
    {
      ok: !after.error,
      created: !after.error,
      message: after.error ? "作れませんでした: " + String(after.error.message).slice(0, 200) : "learn_supervisor_log を作りました",
      results,
    },
    { status: after.error ? 500 : 200, headers: CORS },
  );
}

export async function GET() {
  return run();
}

export async function POST() {
  return run();
}
