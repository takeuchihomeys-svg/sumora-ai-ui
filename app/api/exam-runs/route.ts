// GET  /api/exam-runs       … 試験の統括の結果を新しい順に読む（?limit=50・?touch=0 で印を残さない）
// POST /api/exam-runs       … 手元の結果（SavedResult）を DB に残す（同じ label は上書き）
//
// 2026-11-13 竹内さん「試験の統括と拡張ツールとデータベースの連携の部分をちゃんとできるようにする。
//   より強化できるようにする」
//
// これまで: 統括の結果は `memory/exam-brain/conductor/*.json` の**手元のファイルだけ**で、
//   竹内さんの画面・他の PC・私からは見えなかった（＝連携できていなかった）。
// → ここで DB に残し、`/?summary=1` で**合格率・よく落ちる所・費用**を返す（統括を強化する材料）。
//
// ⚠ 入れるのは点・件数・問題の id・理由・費用だけ。会話の中身・お客様の名前は入れない。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { toExamRun, upsertExamRun, listExamRuns, summarizeExamRuns } from "@/app/lib/exam-runs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 50) || 50, 1), 500);
  const r = await listExamRuns(supabase as never, limit);
  if (!r.ok) {
    // 表がまだ無い時も 200 で返す（画面・スクリプトが止まらないように）
    const missing = /does not exist|42P01|Could not find the table|schema cache/i.test(r.error ?? "");
    return NextResponse.json(
      { ok: false, error: r.error, empty: true, rows: [], missing_table: missing },
      { status: missing ? 200 : 500 },
    );
  }
  const summary = summarizeExamRuns(r.rows);
  return NextResponse.json({ ok: true, count: r.rows.length, summary, rows: r.rows });
}

export async function POST(req: NextRequest) {
  let body: { result?: unknown; plan?: unknown };
  try { body = (await req.json()) as { result?: unknown; plan?: unknown }; }
  catch { return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 }); }

  const local = body.result && typeof body.result === "object" ? (body.result as Record<string, unknown>) : null;
  if (!local) return NextResponse.json({ ok: false, error: "result_required" }, { status: 400 });

  const plan = body.plan && typeof body.plan === "object" ? (body.plan as { candidates?: unknown; material?: unknown }) : null;
  const row = toExamRun(local as never, plan);
  if (!row) return NextResponse.json({ ok: false, error: "label_required" }, { status: 400 });

  const w = await upsertExamRun(supabase as never, row);
  if (!w.ok) {
    const missing = /does not exist|42P01|Could not find the table|schema cache/i.test(w.error ?? "");
    return NextResponse.json(
      { ok: false, error: w.error, saved: false, missing_table: missing },
      { status: missing ? 200 : 500 },
    );
  }
  return NextResponse.json({ ok: true, saved: true, label: row.label, summary: row.summary });
}
