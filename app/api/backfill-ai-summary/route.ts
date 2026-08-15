import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 300;

const BATCH_LIMIT = 20;

function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000")
  );
}

type TargetCustomer = {
  id: string;
  customer_name: string | null;
  line_user_id: string | null;
};

// 顧客の最新アクティブ会話を取得（property_customer_id 優先 → line_user_id フォールバック）
async function findLatestConversationId(customer: TargetCustomer): Promise<string | null> {
  const { data: byCustomerId } = await supabase
    .from("conversations")
    .select("id")
    .eq("property_customer_id", customer.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (byCustomerId?.id) return byCustomerId.id as string;

  if (customer.line_user_id) {
    const { data: byLineUserId } = await supabase
      .from("conversations")
      .select("id")
      .eq("line_user_id", customer.line_user_id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byLineUserId?.id) return byLineUserId.id as string;
  }
  return null;
}

// GET: 対象件数の確認
export async function GET() {
  const { count } = await supabase
    .from("property_customers")
    .select("id", { count: "exact", head: true })
    .or("ai_summary_json.is.null,ai_summary_json->>emotion.is.null")
    .not("status", "in", "(closed_lost,archived)");

  return NextResponse.json({ ok: true, target_count: count ?? 0 });
}

// POST: ai_summary_json 未生成（または emotion 欠落）の顧客に対しサマリーを一括生成
export async function POST() {
  // 1. ai_summary_json が NULL または emotion 欠落 かつ 失注/アーカイブ以外の顧客（最大20件）
  const { data: targets, error: targetsErr } = await supabase
    .from("property_customers")
    .select("id, customer_name, line_user_id")
    .or("ai_summary_json.is.null,ai_summary_json->>emotion.is.null")
    .not("status", "in", "(closed_lost,archived)")
    .order("updated_at", { ascending: false })
    .limit(BATCH_LIMIT);

  if (targetsErr) {
    return NextResponse.json({ ok: false, error: targetsErr.message }, { status: 500 });
  }
  if (!targets?.length) {
    return NextResponse.json({ ok: true, processed: 0, success: 0, failed: 0, results: [] });
  }

  const baseUrl = getBaseUrl();
  let success = 0;
  let failed = 0;
  const results: Array<{ id: string; name: string | null; ok: boolean; error?: string }> = [];

  for (const customer of targets as TargetCustomer[]) {
    try {
      // 2. 最新アクティブ会話を取得
      const conversationId = await findLatestConversationId(customer);

      // 3. /api/customer-summary を内部呼び出し（fetch_from_db でDBから全条件を取得させる）
      const res = await fetch(`${baseUrl}/api/customer-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id: customer.id,
          conversation_id: conversationId,
          fetch_from_db: true,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.ok) {
        success++;
        results.push({ id: customer.id, name: customer.customer_name, ok: true });
      } else {
        failed++;
        results.push({ id: customer.id, name: customer.customer_name, ok: false, error: `HTTP ${res.status}` });
      }
    } catch (e) {
      failed++;
      results.push({
        id: customer.id,
        name: customer.customer_name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // レート制限対策
    await new Promise((r) => setTimeout(r, 300));
  }

  // 4. 集計を返す
  return NextResponse.json({
    ok: true,
    processed: targets.length,
    success,
    failed,
    results,
  });
}
