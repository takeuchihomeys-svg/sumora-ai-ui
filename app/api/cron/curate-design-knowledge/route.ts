import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

async function callClaude(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return data.content?.find((b) => b.type === "text")?.text?.trim() || "";
  } catch {
    return "";
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 1. 現行エントリを全件取得
    const { data: entries, error } = await supabase
      .from("design_knowledge")
      .select("id, category, title, principle, is_current, created_at")
      .eq("is_current", true)
      .order("category", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);
    if (!entries || entries.length === 0) {
      return NextResponse.json({ ok: true, message: "no entries", deprecated: 0, active: 0 });
    }

    // 2. Claude Haiku で矛盾・重複エントリを分析
    const text = await callClaude(`以下は design_knowledge テーブルの現行エントリ（is_current=true）です。

同カテゴリ内で「矛盾・上書き関係にある古いエントリ」のIDを特定してください。

判断基準：
- 同じトピックで数値・パターンが異なる場合、created_at が古い方を非現行候補とする
- 完全に異なるトピックは対象外（保守的に判断する）
- 0件でも可

エントリ一覧（JSON）：
${JSON.stringify(entries.map((e) => ({
  id: e.id,
  category: e.category,
  title: e.title,
  created_at: e.created_at,
})), null, 2)}

以下のJSON形式のみで返答（説明不要）：
{"deprecate":["id1","id2"],"reason":"変更理由"}`);

    let deprecateIds: string[] = [];
    let reason = "";
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { deprecate: string[]; reason: string };
        deprecateIds = Array.isArray(parsed.deprecate) ? parsed.deprecate : [];
        reason = parsed.reason || "";
      }
    } catch {
      // パース失敗は0件として続行
    }

    // 3. 非現行に更新
    if (deprecateIds.length > 0) {
      const { error: updateError } = await supabase
        .from("design_knowledge")
        .update({ is_current: false })
        .in("id", deprecateIds);
      if (updateError) throw new Error(updateError.message);
    }

    // 4. 現行件数を取得
    const { count: activeCount } = await supabase
      .from("design_knowledge")
      .select("*", { count: "exact", head: true })
      .eq("is_current", true);

    return NextResponse.json({
      ok: true,
      deprecated: deprecateIds.length,
      deprecatedIds: deprecateIds,
      reason,
      active: activeCount,
      total: entries.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/curate-design-knowledge] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
