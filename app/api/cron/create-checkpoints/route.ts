import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

// ⚠️ 廃止（2026-08-14）: vercel.json の cron 登録から削除済み。チェックポイントは
// brain-core.ts の maybeCreateCheckpoint（ローリング累積方式・単一writer）が作成する。
// 旧ブロック方式と index の意味が異なるため本cronは再登録しないこと（併用禁止）。
export const maxDuration = 300;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Find conversations with 15+ messages that are missing checkpoints
  const { data: rows, error: queryError } = await supabase.rpc("exec_sql", {
    sql: `
      SELECT DISTINCT m.conversation_id
      FROM messages m
      LEFT JOIN conversation_checkpoints cc ON cc.conversation_id = m.conversation_id
      GROUP BY m.conversation_id
      HAVING COUNT(m.id) >= 15
        AND (
          MAX(cc.checkpoint_index) IS NULL
          OR MAX(cc.checkpoint_index) < FLOOR(COUNT(m.id)::float / 15)
        )
      LIMIT 20;
    `,
  });

  if (queryError) {
    console.error("[cron/create-checkpoints] query error:", queryError.message);
    return NextResponse.json({ error: queryError.message }, { status: 500 });
  }

  const conversationIds: string[] = (rows ?? []).map(
    (r: { conversation_id: string }) => r.conversation_id
  );

  if (conversationIds.length === 0) {
    console.log("[cron/create-checkpoints] no conversations need checkpoints");
    return NextResponse.json({ processed: 0, results: [] });
  }

  console.log(
    `[cron/create-checkpoints] processing ${conversationIds.length} conversations`
  );

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    `https://${process.env.VERCEL_URL ?? "localhost:3000"}`;

  const results: { conversation_id: string; created: number; skipped: number; error?: string }[] = [];

  for (const conversationId of conversationIds) {
    try {
      const res = await fetch(`${baseUrl}/api/create-checkpoint`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({ conversation_id: conversationId }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(
          `[cron/create-checkpoints] create-checkpoint failed for ${conversationId}: ${res.status} ${text}`
        );
        results.push({ conversation_id: conversationId, created: 0, skipped: 0, error: `HTTP ${res.status}` });
        continue;
      }

      const json = (await res.json()) as { created: number; skipped: number };
      console.log(
        `[cron/create-checkpoints] ${conversationId}: created=${json.created} skipped=${json.skipped}`
      );
      results.push({ conversation_id: conversationId, created: json.created ?? 0, skipped: json.skipped ?? 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/create-checkpoints] fetch error for ${conversationId}:`, msg);
      results.push({ conversation_id: conversationId, created: 0, skipped: 0, error: msg });
    }
  }

  const totalCreated = results.reduce((sum, r) => sum + r.created, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
  const errors = results.filter((r) => r.error);

  return NextResponse.json({
    ok: true,
    processed: conversationIds.length,
    totalCreated,
    totalSkipped,
    errorCount: errors.length,
    results,
  });
}
