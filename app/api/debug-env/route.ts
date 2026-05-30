import { NextResponse } from "next/server";

// 環境変数が設定されているかチェック（値は返さず true/false のみ）
export async function GET() {
  return NextResponse.json({
    LINE_SUMORA_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN,
    LINE_SUMORA_CHANNEL_SECRET:       !!process.env.LINE_SUMORA_CHANNEL_SECRET,
    LINE_IEYASU_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN,
    LINE_IEYASU_CHANNEL_SECRET:       !!process.env.LINE_IEYASU_CHANNEL_SECRET,
    LINE_GIGA_CHANNEL_ACCESS_TOKEN:   !!process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN,
    LINE_GIGA_CHANNEL_SECRET:         !!process.env.LINE_GIGA_CHANNEL_SECRET,
    LINE_HASU_CHANNEL_ACCESS_TOKEN:   !!process.env.LINE_HASU_CHANNEL_ACCESS_TOKEN,
    ANTHROPIC_API_KEY:                !!process.env.ANTHROPIC_API_KEY,
    NEXT_PUBLIC_SUPABASE_URL:         !!process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
}
