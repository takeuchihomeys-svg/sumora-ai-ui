import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// LINE group ID の正規フォーマット検証
function isValidLineGroupId(id: string): boolean {
  return /^C[0-9a-f]{32}$/.test(id);
}

export async function GET() {
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN ?? "";

  const { data: groupRow } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .single();

  const groupId = groupRow?.value ?? null;
  const groupIdValid = groupId ? isValidLineGroupId(groupId) : false;

  // LINE bot profile 確認（token が有効かチェック）
  let botName: string | null = null;
  let tokenOk = false;
  if (token) {
    try {
      const res = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const info = await res.json() as { displayName?: string };
        botName = info.displayName ?? null;
        tokenOk = true;
      }
    } catch { /* noop */ }
  }

  const issues: string[] = [
    !token           ? "LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN 未設定" : "",
    !tokenOk && token ? "LINE token が無効（期限切れ or 間違い）" : "",
    !blobToken        ? "BLOB_READ_WRITE_TOKEN 未設定" : "",
    !groupId          ? "group_id 未登録 → LINEグループでメッセージを送ってください" : "",
    groupId && !groupIdValid
      ? `group_id が不正（\"${groupId.slice(0, 12)}...\"）→ POST /api/hanbancyo-check で正しいIDに更新してください` : "",
  ].filter(Boolean);

  return NextResponse.json({
    token_set: !!token,
    token_valid: tokenOk,
    bot_name: botName,
    blob_token_set: !!blobToken,
    group_id_registered: !!groupId,
    group_id_valid: groupIdValid,
    group_id: groupId ? groupId.slice(0, 12) + "..." : null,
    status: tokenOk && groupIdValid && !!blobToken ? "✅ 送信準備OK" : "❌ 設定不足",
    issues,
  });
}

// group_id を手動セット（緊急時・正しいLINEグループIDを直接登録）
// 使い方: POST /api/hanbancyo-check  body: { "group_id": "C..." }
export async function POST(req: NextRequest) {
  const body = await req.json() as { group_id?: string };
  const newId = body.group_id?.trim() ?? "";

  if (!isValidLineGroupId(newId)) {
    return NextResponse.json(
      { ok: false, error: "group_id は C から始まる32桁英数字である必要があります（例: C1234abcd...）" },
      { status: 400 },
    );
  }

  await supabase
    .from("hanbancyo_settings")
    .upsert({ key: "group_id", value: newId }, { onConflict: "key" });

  return NextResponse.json({ ok: true, message: `group_id を ${newId.slice(0, 12)}... にセットしました` });
}
