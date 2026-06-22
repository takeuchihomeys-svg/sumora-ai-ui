import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// お客様が送ってきた物件探しフォーマット文を検出するヒューリスティック
function isFormatMessage(text: string): boolean {
  if (text.length < 30) return false;
  // ①②③ 丸数字パターン
  if (/[①②③④⑤]/.test(text)) return true;
  // 番号リスト系 (1. 2. など)
  if (/^\s*[1-9][.．）]\s/m.test(text)) return true;
  // フォーム系キーワードの複合チェック
  const keywords = ["ご入居", "家賃", "エリア", "築年数", "間取り", "お部屋", "初期費用", "ご希望"];
  const matched = keywords.filter((k) => text.includes(k));
  return matched.length >= 3;
}

export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get("conversation_id");
  if (!conversationId) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });

  const { data: msgs, error } = await supabase
    .from("messages")
    .select("sender, text, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // お客様メッセージの中からフォーマット文を見つける（最初の1件）
  const formatMsg = (msgs ?? []).find(
    (m) => m.sender === "customer" && m.text && isFormatMessage(m.text)
  );

  return NextResponse.json({ ok: true, text: formatMsg?.text ?? null });
}
