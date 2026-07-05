import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 300;

// アカウント定義（send-line-message と同じキー体系）
const ACCOUNTS = [
  { key: "ieyasu", name: "イエヤス", token: process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN },
  { key: "giga",   name: "ギガ賃貸", token: process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN },
  { key: "sumora", name: "スモラ",   token: process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN },
] as const;

// LINE プロフィールAPIで「このユーザーはどのBotをフォローしているか」を判定
async function detectAccount(lineUserId: string): Promise<string> {
  for (const account of ACCOUNTS) {
    if (!account.token) continue;
    const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
      headers: { Authorization: `Bearer ${account.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return account.key;
  }
  return "sumora"; // フォールバック
}

export async function POST(req: NextRequest) {
  // CRON_SECRET fail-closed認証（未設定時も拒否）
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("Authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // 全会話を取得
  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("id, line_user_id, account")
    .not("line_user_id", "is", null);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const results = { updated: 0, skipped: 0, errors: 0 };
  const processed = new Map<string, string>(); // line_user_id → account（同一ユーザーの重複API呼び出しを防ぐ）

  for (const conv of (conversations ?? [])) {
    const uid = conv.line_user_id as string;
    if (!uid) { results.skipped++; continue; }

    try {
      // 同じline_user_idはAPI呼び出し済みの結果を再利用
      let accountKey = processed.get(uid);
      if (!accountKey) {
        accountKey = await detectAccount(uid);
        processed.set(uid, accountKey);
      }

      // アカウントが変わる場合のみ更新
      if (conv.account !== accountKey) {
        await supabase
          .from("conversations")
          .update({ account: accountKey })
          .eq("id", conv.id);
        results.updated++;
      } else {
        results.skipped++;
      }

      // line_contacts にも正しい情報を登録（将来の resolveAccountKey 用）
      const acct = ACCOUNTS.find(a => a.key === accountKey);
      if (acct) {
        await supabase.from("line_contacts").upsert(
          { line_user_id: uid, account: acct.name },
          { onConflict: "line_user_id,account" }
        );
      }
    } catch {
      results.errors++;
    }
  }

  return NextResponse.json({ ok: true, ...results, total: conversations?.length ?? 0 });
}
