// app/api/learn-improvements-init/route.ts
//
// 2026-11-14 竹内さん「また今日強化されたら『強化した』と統括に保存しておくようにする」
//
// `learn_improvements` を**今すぐ**作るための入口（`learn_supervisor_log` と同じ形）。
//
// ⚠ 安全のため:
//   ・**表が無い時だけ**作る（もう在れば RLS だけ直す＝何度呼んでも安全）
//   ・作る物は**この1つの表だけ**
//   ・`SUPABASE_SERVICE_ROLE_KEY` が無ければ何もしない（本番には在る）
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
  `CREATE TABLE IF NOT EXISTS learn_improvements (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  area TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  why TEXT,
  how TEXT,
  effect TEXT,
  verify TEXT,
  version TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_learn_improvements_at ON learn_improvements(at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_learn_improvements_area ON learn_improvements(area, at DESC)`,
  /**
   * 2026-11-14 竹内さん「PLS無効にしたらよいのでは」:
   *   RLS を有効にすると Service Role キーが無い所から書けず、**黙って0件**になる。
   *   入れるのは仕組みの話だけなので、公開キーでも書けるようにする。
   */
  `ALTER TABLE learn_improvements DISABLE ROW LEVEL SECURITY`,
  `COMMENT ON TABLE learn_improvements IS '学習の強化の記録（何を・なぜ・どう直した・効くはずの所・確かめ方）。仕組みの話だけ。2026-11-14 竹内さん承認'`,
  `SELECT pg_notify('pgrst', 'reload schema')`,
];

async function run() {
  // ① もう在るか（在れば RLS だけ直す）
  const probe = await supabase.from("learn_improvements").select("id").limit(1);
  if (!probe.error) {
    const fix = await supabase.rpc("exec_sql", { sql: "ALTER TABLE learn_improvements DISABLE ROW LEVEL SECURITY;" });
    const rlsError = fix.error ? String(fix.error.message).slice(0, 200) : null;
    const cnt = await supabase.from("learn_improvements").select("*", { count: "exact", head: true });
    return NextResponse.json(
      {
        ok: true,
        already: true,
        rls_disabled: !rlsError,
        message: rlsError
          ? "learn_improvements はあります（RLS の解除に失敗: " + rlsError + "）"
          : "learn_improvements はあります（RLS を無効にしました）",
        rows: cnt.error ? null : (cnt.count ?? 0),
      },
      { headers: CORS },
    );
  }

  // ② 作る
  const results: Array<{ step: string; ok: boolean; error?: string }> = [];
  for (const sql of DDL) {
    const { error } = await supabase.rpc("exec_sql", { sql });
    results.push({ step: sql.replace(/\s+/g, " ").slice(0, 60), ok: !error, ...(error ? { error: String(error.message).slice(0, 200) } : {}) });
    if (error && /permission denied/i.test(String(error.message || ""))) {
      return NextResponse.json(
        {
          ok: false,
          reason: "exec_sql の権限がありません（サービスロールのキーが必要）",
          hint: "migrate-schema（JST 0:10）でも作られます",
          results,
        },
        { status: 403, headers: CORS },
      );
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
  const after = await supabase.from("learn_improvements").select("id").limit(1);
  return NextResponse.json(
    {
      ok: !after.error,
      created: !after.error,
      message: after.error ? "作れませんでした: " + String(after.error.message).slice(0, 200) : "learn_improvements を作りました",
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
