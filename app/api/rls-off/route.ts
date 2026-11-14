// app/api/rls-off/route.ts
//
// 2026-11-14 竹内さん「RLS無効にする」
//
// なぜ要るか:
//   実測（公開キーで読む）:
//     human_motion_learn  → 0件（RLS で読めない）
//     human_learn_profile → 0件（RLS で読めない）
//     search_audits / automation_commands / property_customers → 読める
//   ⚠ この2つだけ RLS が有効なため、**Service Role キーが無い所から読めない・書けない**。
//     そのせいで「写真学習が1枚も動かない」「学習の束が残らない」が起きていた。
//   → 他の表と同じ扱い（DISABLE）にそろえる。
//
//   ⚠ 入れるのは**数・傾向・欄の名前だけ**（入力した中身・名前・電話・住所は入れない）ので、
//     公開キーで読み書きできても個人情報は漏れない。**消す操作はしない**（RLS の設定だけ）。
//
// 使い方: GET /api/rls-off（何度呼んでも安全・状態を返すだけ）
import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** RLS を外す表（この2つだけ有効だった） */
const TABLES = ["human_motion_learn", "human_learn_profile"] as const;

async function run() {
  const results: Array<{ table: string; ok: boolean; error?: string }> = [];
  for (const t of TABLES) {
    const sql = `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`;
    const { error } = await supabase.rpc("exec_sql", { sql });
    results.push({ table: t, ok: !error, ...(error ? { error: String(error.message).slice(0, 200) } : {}) });
  }
  // スキーマのキャッシュを更新（PostgREST が新しい権限を読むように）
  try { await supabase.rpc("exec_sql", { sql: "SELECT pg_notify('pgrst', 'reload schema');" }); } catch { /* 気にしない */ }
  await new Promise((r) => setTimeout(r, 1500));
  /**
   * 確かめる: 公開キーで読めるようになったか（件数だけ）。
   *   ⚠ ここは**サーバーの鍵**で読むので「RLS が外れたか」の直接の証拠にはならないが、
   *     少なくとも表が壊れていない事は分かる。
   */
  const checks: Array<{ table: string; rows: number | null; error?: string }> = [];
  for (const t of TABLES) {
    const q = await supabase.from(t).select("id", { count: "exact", head: true });
    checks.push({ table: t, rows: q.error ? null : (q.count ?? 0), ...(q.error ? { error: String(q.error.message).slice(0, 120) } : {}) });
  }
  const denied = results.filter((r) => !r.ok && /permission denied/i.test(String(r.error || ""))).length;
  return NextResponse.json(
    {
      ok: results.every((r) => r.ok),
      message: denied
        ? "exec_sql の権限がありません（Service Role キーが必要）。migrate-schema（JST 0:10）でも外れます"
        : "RLS を無効にしました（migrate-schema にも同じ1行を入れてあります）",
      results,
      checks,
    },
    { status: results.every((r) => r.ok) ? 200 : 403, headers: CORS },
  );
}

export async function GET() {
  return run();
}

export async function POST() {
  return run();
}
