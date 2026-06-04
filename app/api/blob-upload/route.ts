import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

// itandi PDF を1件ずつバイナリで受け取ってVercel Blobに保存 → URL返却
// ペイロードはbase64ではなくbinaryなのでサイズが33%小さい
export async function POST(req: NextRequest) {
  const fileName = req.nextUrl.searchParams.get("name") ?? `pdf_${Date.now()}.pdf`;

  const arrayBuffer = await req.arrayBuffer();
  if (!arrayBuffer.byteLength) {
    return NextResponse.json({ ok: false, error: "空のリクエストです" }, { status: 400 });
  }

  const blob = await put(fileName, arrayBuffer, {
    access: "public",
    contentType: "application/pdf",
    allowOverwrite: true,
  });

  return NextResponse.json({ ok: true, url: blob.url });
}
