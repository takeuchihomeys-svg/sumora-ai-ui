import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

/**
 * GET /api/prompt-rules
 * アクティブな HUMAN-* ルール一覧を返す（永久ルール管理UI用）
 * is_permanent の昇降含む全件を返し、UI側でフィルタして表示する
 */
export async function GET() {
  const { data, error } = await supabase
    .from("ai_prompt_rules")
    .select("id, rule_key, rule_text, is_permanent, updated_at, priority")
    .eq("is_active", true)
    .like("rule_key", "HUMAN-%")
    .order("is_permanent", { ascending: false })
    .order("updated_at", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("[GET /api/prompt-rules] error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ rules: data ?? [] });
}

/**
 * PATCH /api/prompt-rules
 * HUMAN-* ルールの is_permanent フラグを更新する（昇格/降格）
 * body: { id: string, is_permanent: boolean }
 */
export async function PATCH(req: Request) {
  let body: { id?: string; is_permanent?: boolean };
  try {
    body = (await req.json()) as { id?: string; is_permanent?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { id, is_permanent } = body;
  if (!id || typeof is_permanent !== "boolean") {
    return NextResponse.json({ error: "id と is_permanent（boolean）が必要です" }, { status: 400 });
  }

  // HUMAN-* ルールのみ操作可能（安全ガード）
  const { data: existing, error: fetchError } = await supabase
    .from("ai_prompt_rules")
    .select("rule_key")
    .eq("id", id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: "ルールが見つかりません" }, { status: 404 });
  }
  if (!existing.rule_key.startsWith("HUMAN-")) {
    return NextResponse.json({ error: "HUMAN-* ルール以外は操作できません" }, { status: 403 });
  }

  const { error } = await supabase
    .from("ai_prompt_rules")
    .update({ is_permanent, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[PATCH /api/prompt-rules] error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    id,
    is_permanent,
    message: is_permanent
      ? "永久ルールに昇格しました。次回の返信生成から50件上限外で常時注入されます。"
      : "通常ルールに降格しました。50件上限の対象に戻ります。",
  });
}
