import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// 期限切れ画像をStorageから削除してimage_urlをnullにする
// POST /api/cleanup-images  (x-cron-secret or Vercel cron auth)
// 毎日3:23 AM にVercel Cronで自動実行
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = cronSecret ? authHeader === `Bearer ${cronSecret}` : false;
  if (secret !== "hasu-cron-secret-2024" && !isVercelCron) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();

  // 期限切れ かつ image_url がある（まだStorage未削除）メッセージを取得
  const { data: expired, error: fetchErr } = await supabase
    .from("messages")
    .select("id, image_url")
    .eq("sender", "customer")
    .lt("image_expires_at", now)
    .not("image_url", "is", null)
    .limit(200);

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!expired || expired.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0, message: "期限切れ画像なし" });
  }

  let deletedStorage = 0;
  let failedStorage = 0;

  // Storageからファイルを削除（パスをimage_urlから逆引き）
  const storagePaths: string[] = [];
  for (const msg of expired) {
    const url = msg.image_url as string;
    // URL例: https://xxx.supabase.co/storage/v1/object/public/line-images/abc123.jpg
    const match = url.match(/\/line-images\/(.+)$/);
    if (match?.[1]) storagePaths.push(match[1]);
  }

  if (storagePaths.length > 0) {
    const { error: removeErr } = await supabase.storage
      .from("line-images")
      .remove(storagePaths);
    if (removeErr) {
      console.error("[cleanup-images] Storage削除エラー:", removeErr.message);
      failedStorage = storagePaths.length;
    } else {
      deletedStorage = storagePaths.length;
    }
  }

  // messages.image_url を null にする（UIで「保存期間終了」表示のため）
  const ids = expired.map((m) => m.id as string);
  await supabase
    .from("messages")
    .update({ image_url: null })
    .in("id", ids);

  return NextResponse.json({
    ok: true,
    deleted: ids.length,
    deletedStorage,
    failedStorage,
    cleanedAt: now,
  });
}

// GET /api/cleanup-images
// Vercel CronはGETでリクエストするため、認証チェック後POSTへ委譲
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
