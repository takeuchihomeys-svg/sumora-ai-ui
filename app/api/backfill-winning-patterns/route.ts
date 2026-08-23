import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 300;

// POST /api/backfill-winning-patterns
// ai_reply_knowledge category='pattern' の既存データを winning_patterns へ移行する。
// バッチ実行: limit/offset で分割して複数回叩くことを想定（1回100件ずつ）。
// embedding はそのままコピー（再生成コストゼロ）。
// content フォーマット: "winning_pattern\n---\n転換点: xxx\n効果: xxx"
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100"), 200);
  const offset = parseInt(searchParams.get("offset") ?? "0");

  // 移行済み source_conversation_id を除外するため、既存レコードの source を取得
  const { data: existingSources } = await supabase
    .from("winning_patterns")
    .select("source_conversation_id")
    .not("source_conversation_id", "is", null);
  const alreadyMigrated = new Set(
    (existingSources ?? []).map((r: { source_conversation_id: string | null }) => r.source_conversation_id).filter(Boolean)
  );

  // ai_reply_knowledge から pattern カテゴリを取得
  const { data: rows, error } = await supabase
    .from("ai_reply_knowledge")
    .select("id, title, content, embedding, importance, conversation_state, created_at")
    .eq("category", "pattern")
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) return NextResponse.json({ ok: true, migrated: 0, total: 0, done: true });

  type ArkRow = { id: string; title: string | null; content: string | null; embedding: unknown; importance: number | null; conversation_state: string | null; created_at: string };
  const typedRows = rows as ArkRow[];

  let migrated = 0;
  let skipped = 0;

  for (const row of typedRows) {
    // title から human_type_label と outcome_type を推定
    // フォーマット: "[成約分析] ラベル" / "[失注分析] ラベル" / "[転換点] ラベル" / "[失注転換点] ラベル"
    const titleStr = row.title ?? "";
    const isLost = titleStr.includes("失注");
    const outcomeType = isLost ? "closed_lost" : "closed_won";
    const humanTypeLabel = titleStr.replace(/^\[.*?\]\s*/, "").trim() || null;

    // content から pattern / notes を分離
    // フォーマット: "winning_pattern\n---\n転換点: xxx\n効果: xxx"
    const contentStr = row.content ?? "";
    const parts = contentStr.split("\n---\n");
    const pattern = parts[0]?.trim() || contentStr.trim();
    const notes = parts[1]?.trim() || null;

    // 移行済みチェック（source_conversation_idがないのでIDベースで重複防止しない → titleで簡易チェック）
    // source_conversation_id は ai_reply_knowledge 側には保持していないため null
    const insertData = {
      situation: humanTypeLabel,
      pattern: pattern || "（パターン不明）",
      closing_action: null as string | null,
      human_type_label: humanTypeLabel,
      outcome_type: outcomeType,
      notes,
      source_conversation_id: null as string | null,
      embedding: row.embedding ? JSON.stringify(row.embedding) : null,
      importance: row.importance ?? 8,
      created_at: row.created_at,
    };

    // closing_action を notes から抽出（"効果: xxx" or "取るべきだった対応: xxx"）
    if (notes) {
      const effectMatch = notes.match(/(?:効果|取るべきだった対応)[：:]\s*(.+)/);
      if (effectMatch) insertData.closing_action = effectMatch[1].trim();
    }

    const { error: insertErr } = await supabase.from("winning_patterns").insert(insertData);
    if (insertErr) {
      skipped++;
    } else {
      migrated++;
    }
  }

  const done = rows.length < limit;
  return NextResponse.json({ ok: true, migrated, skipped, offset, limit, done });
}
