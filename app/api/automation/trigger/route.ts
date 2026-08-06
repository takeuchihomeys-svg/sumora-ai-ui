import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  // 障害修正: SUPABASE_SERVICE_ROLE_KEY 未設定でも空500クラッシュせず anon キーへフォールバック
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { error: "server misconfigured: SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY missing" },
      { status: 500 }
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const body = await req.json() as {
    customer_ids?: string[];
    sites?: string[];
    force?: boolean;
    is_wide?: boolean; // 修正5: 広ボタンのキュー経路伝搬
  };

  const wantIds = JSON.stringify([...(body.customer_ids ?? [])].sort());
  const wantSites = JSON.stringify([...(body.sites ?? ["reins"])].sort());
  const wantWide = !!body.is_wide;

  // 修正6: force:true でも同一 customer_ids + sites + is_wide の直近5分内コマンドはデデュープ。
  // 拡張入りPCでWebApp操作すると即時経路とキュー経路が両方走り、同一顧客に
  // 検索・AI採点・LINE送信が2回発生するのを防ぐ最終防衛線。
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("automation_commands")
    .select("id, customer_ids, sites, payload")
    .eq("command_type", "batch_property_search")
    .gte("created_at", fiveMinAgo)
    .order("created_at", { ascending: false })
    .limit(20);

  const dup = (recent ?? []).find((r) => {
    const rIds = JSON.stringify([...((r.customer_ids as string[] | null) ?? [])].sort());
    const rSites = JSON.stringify([...((r.sites as string[] | null) ?? [])].sort());
    const rWide = !!(r.payload as { is_wide?: boolean } | null)?.is_wide;
    return rIds === wantIds && rSites === wantSites && rWide === wantWide;
  });
  if (dup) {
    return NextResponse.json({ ok: true, commandId: dup.id, deduped: true });
  }

  if (!body.force) {
    const { data: existing } = await supabase
      .from("automation_commands")
      .select("id, status")
      .in("status", ["pending", "running"])
      .limit(1);

    if (existing && existing.length > 0) {
      return NextResponse.json({ ok: true, commandId: existing[0].id, reused: true });
    }
  }

  const { data, error } = await supabase
    .from("automation_commands")
    .insert({
      command_type: "batch_property_search",
      customer_ids: body.customer_ids ?? null,
      sites: body.sites ?? ["reins"],
      // 修正5: is_wide を payload に保存（拡張側 _runBatchSearch が参照する）
      payload: { is_wide: wantWide },
      status: "pending",
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, commandId: data.id });
}
