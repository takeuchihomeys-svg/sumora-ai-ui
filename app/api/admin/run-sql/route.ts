// POST /api/admin/run-sql
// 2026-11-13 竹内さん「連携されてるから実行おねがい。データベースへのいこう」
//
// 何をするか:
//   DB の変更（DDL）を**竹内さんの手元から1回だけ**当てるための口。
//   通常は migrate-schema（毎晩0:10）が全部流すので、**急ぎの時だけ**ここを使う。
//
// ⚠ 安全のため:
//   ・合言葉（ADMIN_SQL_SECRET。無ければ SYNC_SECRET）が要る（合わなければ 401）
//   ・**許可した文だけ**（CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS /
//     COMMENT ON / ENABLE ROW LEVEL SECURITY / CREATE INDEX IF NOT EXISTS / DELETE の限定形）
//   ・DROP / TRUNCATE / 無条件の DELETE / UPDATE は**通さない**
//   ・1回で流すのは最大 10 文
//   ・何を流したかを返す（結果は cron_run_logs にも残さない＝軽い）
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 通してよい文か（先頭で判定・危ない物は断る） */
export function sqlAllowed(sql: string): { ok: boolean; reason?: string } {
  const s = sql.trim();
  if (!s) return { ok: false, reason: "empty" };
  if (s.length > 8000) return { ok: false, reason: "too_long" };
  // ⚠ 絶対に通さない物
  if (/\b(DROP|TRUNCATE|GRANT|REVOKE|CREATE\s+ROLE|ALTER\s+ROLE)\b/i.test(s)) {
    return { ok: false, reason: "forbidden_keyword" };
  }
  if (/^\s*UPDATE\b/i.test(s)) return { ok: false, reason: "update_forbidden" };
  if (/^\s*DELETE\b/i.test(s) && !/\bWHERE\b/i.test(s)) return { ok: false, reason: "delete_needs_where" };
  // 通す物（先頭の文で判定）
  const head = s.split(/\s+/).slice(0, 4).join(" ").toUpperCase();
  const okHeads = [
    "CREATE TABLE IF NOT EXISTS",
    "CREATE INDEX IF NOT EXISTS",
    "ALTER TABLE",
    "COMMENT ON",
    "DELETE",
    "SELECT PG_NOTIFY",
  ];
  if (!okHeads.some((h) => head.startsWith(h))) return { ok: false, reason: "head_not_allowed: " + head };
  // ALTER TABLE は ADD COLUMN IF NOT EXISTS / ENABLE ROW LEVEL SECURITY だけ
  if (/^\s*ALTER\s+TABLE/i.test(s)) {
    if (!/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i.test(s) && !/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(s)) {
      return { ok: false, reason: "alter_kind_not_allowed" };
    }
  }
  return { ok: true };
}

export async function POST(req: NextRequest) {
  const secret = (process.env.ADMIN_SQL_SECRET ?? process.env.SYNC_SECRET ?? "").trim();
  if (!secret) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { sql?: unknown };
  try { body = (await req.json()) as { sql?: unknown }; } catch { return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 }); }

  // 文に分ける（; 区切り・コメント行は捨てる）
  const raw = typeof body.sql === "string" ? body.sql : "";
  const stmts = raw
    .split(";")
    .map((x) => x.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").trim())
    .filter(Boolean);
  if (!stmts.length) return NextResponse.json({ ok: false, error: "no_statements" }, { status: 400 });
  if (stmts.length > 10) return NextResponse.json({ ok: false, error: "too_many_statements", count: stmts.length }, { status: 400 });

  const results: Array<{ sql: string; ok: boolean; error?: string }> = [];
  for (const s of stmts) {
    const allow = sqlAllowed(s);
    if (!allow.ok) {
      results.push({ sql: s.slice(0, 120), ok: false, error: "refused: " + allow.reason });
      break; // 1つでも断ったらそこで止める（中途半端に当てない）
    }
    const { error } = await supabase.rpc("exec_sql", { sql: s });
    results.push({ sql: s.slice(0, 120), ok: !error, ...(error ? { error: error.message } : {}) });
    if (error) break;
  }

  const ok = results.every((r) => r.ok);
  return NextResponse.json({ ok, count: results.length, results }, { status: ok ? 200 : 500 });
}
