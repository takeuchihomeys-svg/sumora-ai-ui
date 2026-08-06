import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  // 修正10: 共有シークレット認証（AUTOMATION_API_KEY 設定時のみ強制。未設定なら従来通り許可）
  const apiKey = process.env.AUTOMATION_API_KEY;
  if (apiKey && req.headers.get("x-automation-key") !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 障害修正: SUPABASE_SERVICE_ROLE_KEY 未設定でも空500クラッシュせず、
  // anon キーへフォールバック（automation_commands は RLS 無効のため機能同等）。
  // 両方欠落時は明示的な JSON エラーを返して障害を可視化する。
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { error: "server misconfigured: SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY missing" },
      { status: 500 }
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // 修正2: サーバー側ウォッチドッグ — running のまま30分以上放置されたコマンドを pending に戻す
  // （拡張SWクラッシュ等でコマンドが永久に running のまま止まるのを防ぐ）
  const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { error: staleErr } = await supabase
    .from("automation_commands")
    .update({ status: "pending", picked_up_at: null })
    .eq("status", "running")
    .lt("picked_up_at", staleBefore);
  if (staleErr) {
    console.warn("[automation/pending] stale-running reset error:", staleErr.message);
  }

  const { data: commands, error: selErr } = await supabase
    .from("automation_commands")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (selErr) {
    return NextResponse.json({ error: selErr.message }, { status: 500 });
  }
  if (!commands || commands.length === 0) {
    return NextResponse.json({ command: null });
  }

  const cmd = commands[0];

  // 修正3: 条件付きUPDATE + .select() で claim 成功を確認する。
  // 複数PCが同時にポーリングした場合、先に claim した方だけが実行権を得る。
  // 0行更新（= 他のPCが先に claim 済み）なら command: null を返して二重実行を防ぐ。
  const { data: claimed, error: updErr } = await supabase
    .from("automation_commands")
    .update({ status: "running", picked_up_at: new Date().toISOString() })
    .eq("id", cmd.id)
    .eq("status", "pending")
    .select();

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ command: null });
  }

  return NextResponse.json({ command: { ...cmd, status: "running" } });
}
