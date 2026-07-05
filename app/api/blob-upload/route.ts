import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

// itandi PDF を1件ずつバイナリで受け取ってVercel Blobに保存 → URL返却
// ペイロードはbase64ではなくbinaryなのでサイズが33%小さい

// ファイルサイズ上限: 20MB
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// 受け付けるContent-Typeのallowlist
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

// 制御文字（NUL〜US・DEL）を含むパスを拒否
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export async function POST(req: NextRequest) {
  const rawName = req.nextUrl.searchParams.get("name") ?? `pdf_${Date.now()}.pdf`;

  // パス検証: 先頭スラッシュに正規化した上で、`..` と制御文字を拒否
  const fileName = rawName.startsWith("/") ? rawName : `/${rawName}`;
  if (
    !fileName.startsWith("/") ||
    fileName.includes("..") ||
    CONTROL_CHARS.test(fileName)
  ) {
    return NextResponse.json({ ok: false, error: "不正なファイルパスです" }, { status: 400 });
  }

  // Content-Type検証（allowlist方式）
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return NextResponse.json(
      { ok: false, error: `許可されていないContent-Typeです: ${contentType || "(なし)"}` },
      { status: 400 },
    );
  }

  const arrayBuffer = await req.arrayBuffer();
  if (!arrayBuffer.byteLength) {
    return NextResponse.json({ ok: false, error: "空のリクエストです" }, { status: 400 });
  }

  // サイズ上限チェック（20MB）
  if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
    return NextResponse.json(
      { ok: false, error: "ファイルサイズが上限（20MB）を超えています" },
      { status: 400 },
    );
  }

  // Vercel Blobのpathnameは先頭スラッシュなしで渡す
  const blob = await put(fileName.slice(1), arrayBuffer, {
    access: "public",
    contentType,
    allowOverwrite: true,
  });

  return NextResponse.json({ ok: true, url: blob.url });
}
