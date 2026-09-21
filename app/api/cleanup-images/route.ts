import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

// 期限切れ画像をStorageから削除してimage_urlをnullにする
// POST /api/cleanup-images  (x-cron-secret or Vercel cron auth)
// 毎日3:23 AM にVercel Cronで自動実行
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();
  // ?dry=1 は「消す予定」だけ返す（お客様の画像の削除もしない）
  if (new URL(req.url).searchParams.get("dry") === "1") {
    return NextResponse.json({ ok: true, dry: true, uploads: await cleanupExpiredUploads(req) });
  }

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
    // お客様の画像が0件の日も、こちらが送った画像の保存期間の掃除は動かす
    const uploads = await cleanupExpiredUploads(req);
    return NextResponse.json({ ok: true, deleted: 0, message: "期限切れ画像なし", uploads });
  }

  let deletedStorage = 0;
  let failedStorage = 0;

  // Storageからファイルを削除（パスをimage_urlから逆引き）
  // message id → Storageパス の対応を保持し、削除成功した行だけDB更新する
  const pathByMsgId = new Map<string, string>();
  const noStoragePathIds: string[] = []; // line-images外のURL（Storage削除対象なし）
  for (const msg of expired) {
    const url = msg.image_url as string;
    // URL例: https://xxx.supabase.co/storage/v1/object/public/line-images/abc123.jpg
    const match = url.match(/\/line-images\/(.+)$/);
    if (match?.[1]) pathByMsgId.set(msg.id as string, match[1]);
    else noStoragePathIds.push(msg.id as string);
  }

  const storagePaths = Array.from(new Set(pathByMsgId.values()));
  let storageRemoveFailed = false;
  if (storagePaths.length > 0) {
    const { error: removeErr } = await supabase.storage
      .from("line-images")
      .remove(storagePaths);
    if (removeErr) {
      console.error("[cleanup-images] Storage削除エラー:", removeErr.message);
      failedStorage = storagePaths.length;
      storageRemoveFailed = true;
    } else {
      deletedStorage = storagePaths.length;
    }
  }

  // messages.image_url を null にする（UIで「保存期間終了」表示のため）
  // Storage削除に失敗した行はDBを更新しない → 次回Cronで再試行される（孤児ファイル防止）
  const ids = [
    ...noStoragePathIds,
    ...(storageRemoveFailed ? [] : Array.from(pathByMsgId.keys())),
  ];
  if (ids.length > 0) {
    await supabase
      .from("messages")
      .update({ image_url: null })
      .in("id", ids);
  }

  const uploads = await cleanupExpiredUploads(req);

  return NextResponse.json({
    ok: true,
    deleted: ids.length,
    deletedStorage,
    failedStorage,
    uploads,
    cleanedAt: now,
  });
}

// ─── 2026-09-22 竹内「画像の保存期間を3ヶ月とかにしている方が良い。公式LINEのように。
//   そうじゃないと画像増えすぎると重くなっていく一方」───────────────────────────
// こちらが LINE で送るためにアップロードした画像（property-images）は**消す仕組みが無かった**:
//   6,699ファイル・6.1GB・毎月1.5〜2GB 増加（お客様の画像 line-images は上で30日で消えている）。
// → アップロードから UPLOAD_RETENTION_DAYS 日で消す。対象の選び方は DB の expired_line_upload_objects の1か所
//   （送信用のフォルダだけ・最近のメッセージが同じ画像を使っている物と予約送信の物は残す）。
// ⚠ property-images には公開キーでの削除権限が無い（付けるとアプリに入っている公開キーで誰でも消せる）。
//   サーバー専用の鍵（SUPABASE_SERVICE_ROLE_KEY）がある時だけ消す。無ければ**消さずに**そう返す。
//   Storage の remove は権限が無いとエラーにならず「0件消えた」で終わるので、**実際に消えた物だけ**を記録に反映する。
// 消した画像のメッセージは image_url を空にし image_expires_at を今にする → 画面は「🔒 保存期間が終了しました」。
// 画像から読んだ文字（物件名・条件・書き起こし）は DB に文字で残るので、ブレイン・返信の判断は変わらない。
const UPLOAD_RETENTION_DAYS = 90;
const UPLOAD_BATCH = 500;

async function cleanupExpiredUploads(req: NextRequest) {
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const { data: targets, error } = await supabase.rpc("expired_line_upload_objects", { p_days: UPLOAD_RETENTION_DAYS, p_limit: UPLOAD_BATCH });
  if (error) return { error: error.message };
  const rows = (targets ?? []) as Array<{ name: string; size: number | null; created_at: string }>;
  const bytes = rows.reduce((n, r) => n + (r.size ?? 0), 0);
  const summary = { retentionDays: UPLOAD_RETENTION_DAYS, candidates: rows.length, candidateMB: Math.round(bytes / 1024 / 1024), oldest: rows[0]?.created_at ?? null };
  if (dry || rows.length === 0) return { ...summary, dry, removed: 0 };

  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!serviceKey) {
    console.warn(JSON.stringify({ tag: "cleanup-images:uploads-skipped", reason: "no_service_role_key", candidates: rows.length }));
    return { ...summary, removed: 0, skipped: "SUPABASE_SERVICE_ROLE_KEY が無いため削除していません（公開キーには削除権限が無い）" };
  }
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", serviceKey);
  const { data: removed, error: rmErr } = await admin.storage.from("property-images").remove(rows.map((r) => r.name));
  if (rmErr) {
    console.error("[cleanup-images] uploads 削除エラー:", rmErr.message);
    return { ...summary, removed: 0, error: rmErr.message };
  }
  // 実際に消えた物だけ（権限が無いと空で返る）
  const gone = new Set(((removed ?? []) as Array<{ name: string }>).map((o) => o.name));
  let messagesExpired = 0;
  const nowIso = new Date().toISOString();
  for (const name of gone) {
    const { data: upd } = await supabase.from("messages")
      .update({ image_url: null, image_expires_at: nowIso })
      .like("image_url", `%/property-images/${name}%`)
      .select("id");
    messagesExpired += (upd ?? []).length;
  }
  console.log(JSON.stringify({ tag: "cleanup-images:uploads", ...summary, removed: gone.size, messagesExpired }));
  return { ...summary, removed: gone.size, messagesExpired };
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
