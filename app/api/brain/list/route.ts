import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { BRAIN_SKIP_STATUSES, URGENT_WINDOW_MS, type SuggestedAixMeta } from "@/app/lib/brain-core";

// ── brain/list: 純粋な read エンドポイント ──────────────────────────────────
// FIX(Fable5 #2): 以前はこの GET の中で最大30会話ぶんの Haiku 分析を並列実行しており、
// ダッシュボードのコールドロードが Haiku レイテンシに縛られていた。
// 分析は line-webhook（顧客メッセージ受信 = meta を消すのと同じイベント）と
// cron/brain-sweep（バックストップ）に移設。ここは DB を読むだけ（サブ秒応答）。
// 分析ロジック本体は app/lib/brain-core.ts（single writer）。

export const maxDuration = 30;

type BrainConversation = {
  id: string;
  customer_name: string | null;
  status: string | null;
  updated_at: string;
  last_message: string | null;
  suggested_aix_meta: SuggestedAixMeta;
  ai_draft: string | null;
  property_customer_id: string | null;
  brain_analyzed_at: string | null;
  is_urgent: boolean;
};

export async function GET(_req: NextRequest) {
  // 1. Fetch all active conversations where it is the customer's turn
  const { data: conversations, error } = await supabase
    .from("conversations")
    .select(
      "id, customer_name, status, updated_at, last_message, suggested_aix_meta, ai_draft, property_customer_id, brain_analyzed_at"
    )
    .eq("last_sender", "customer")
    // B7(Fable5): 旧 .not("status","in",...) は NULL status の行を除外していた（NOT IN の NULL セマンティクス）
    .or(`status.is.null,status.not.in.(${BRAIN_SKIP_STATUSES.join(",")})`)
    .order("updated_at", { ascending: false })
    // B9(Fable5): 無制限クエリは PostgREST の max-rows（デフォルト1000行）で無言切り捨てされる。
    // updated_at 降順のため limit 200 で切れるのは最も古い（=優先度最低の）会話のみ
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (conversations ?? []) as Array<{
    id: string;
    customer_name: string | null;
    status: string | null;
    updated_at: string;
    last_message: string | null;
    suggested_aix_meta: SuggestedAixMeta;
    ai_draft: string | null;
    property_customer_id: string | null;
    brain_analyzed_at: string | null;
  }>;

  // 2. Build typed result with urgency flag（分析はここでは走らない — webhook/sweep が書いた meta をそのまま返す）
  const now = Date.now();
  const result: BrainConversation[] = rows.map((c) => ({
    id: c.id,
    customer_name: c.customer_name,
    status: c.status,
    updated_at: c.updated_at,
    last_message: c.last_message ?? null,
    suggested_aix_meta: c.suggested_aix_meta ?? null,
    ai_draft: c.ai_draft ?? null,
    property_customer_id: c.property_customer_id ?? null,
    brain_analyzed_at: c.brain_analyzed_at ?? null,
    is_urgent: now - new Date(c.updated_at).getTime() <= URGENT_WINDOW_MS,
  }));

  // 3. Sort: urgent conversations (last customer message ≤ 2h ago) first,
  //    then the rest — both groups already ordered by updated_at DESC from the DB query
  result.sort((a, b) => {
    if (a.is_urgent === b.is_urgent) return 0;
    return a.is_urgent ? -1 : 1;
  });

  return NextResponse.json(result);
}
