import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 30;

const GROUP_ID = "Cdacb0a3b75ba2513a2db6030248cf1bb";

export async function GET(req: NextRequest) {
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!token) return NextResponse.json({ error: "LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN 未設定" }, { status: 500 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // グループメンバー全員を取得（ページネーション対応）
  const members: { type: string; userId: string; displayName: string; pictureUrl?: string }[] = [];
  let nextToken: string | undefined;
  do {
    const url = nextToken
      ? `https://api.line.me/v2/bot/group/${GROUP_ID}/members/all?start=${nextToken}`
      : `https://api.line.me/v2/bot/group/${GROUP_ID}/members/all`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json({ error: "LINE API エラー", status: res.status, body }, { status: 502 });
    }
    const data = await res.json() as { members?: typeof members; next?: string };
    if (data.members) members.push(...data.members);
    nextToken = data.next;
  } while (nextToken);

  // 鈴木を名前で探す
  const suzuki = members.find(m => m.displayName.includes("鈴木"));
  if (!suzuki) {
    return NextResponse.json({
      error: "グループに「鈴木」が見つからなかった",
      members: members.map(m => ({ displayName: m.displayName, userId: m.userId })),
    }, { status: 404 });
  }

  // DB に保存
  const { error: dbErr } = await supabase
    .from("hanbancyo_settings")
    .upsert({ key: "suzuki_line_user_id", value: suzuki.userId }, { onConflict: "key" });

  if (dbErr) return NextResponse.json({ error: "DB保存失敗", detail: dbErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    saved: { displayName: suzuki.displayName, userId: suzuki.userId },
    allMembers: members.map(m => ({ displayName: m.displayName, userId: m.userId })),
  });
}
