import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

// 修正10: status は enum 検証、更新フィールドはホワイトリスト方式で明示抽出
const ALLOWED_STATUS = ["pending", "running", "done", "completed", "error"];

export async function POST(req: NextRequest) {
  // 修正10: 共有シークレット認証（AUTOMATION_API_KEY 設定時のみ強制。未設定なら従来通り許可）
  const apiKey = process.env.AUTOMATION_API_KEY;
  if (apiKey && req.headers.get("x-automation-key") !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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

  const body = (await req.json()) as Record<string, unknown>;

  const id = body.id;
  if (!id || (typeof id !== "string" && typeof id !== "number")) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !ALLOWED_STATUS.includes(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    updates.status = body.status;
  }
  if (typeof body.processed_customers === "number") updates.processed_customers = body.processed_customers;
  if (typeof body.total_customers === "number") updates.total_customers = body.total_customers;
  if (body.results !== undefined && typeof body.results === "object" && body.results !== null) {
    updates.results = body.results;
  }
  if (typeof body.error_message === "string") updates.error_message = body.error_message.slice(0, 2000);
  if (typeof body.completed_at === "string") updates.completed_at = body.completed_at;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no valid fields" }, { status: 400 });
  }

  const { error } = await supabase
    .from("automation_commands")
    .update(updates)
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
