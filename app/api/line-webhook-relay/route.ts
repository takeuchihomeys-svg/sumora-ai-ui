import { NextRequest, NextResponse } from "next/server";

// LINE webhook を受け取り、2つの宛先に並行転送する
const FORWARD_URLS = [
  "https://sumora-screening-admin.vercel.app/api/line-webhook", // 管理ツール
  "https://sumora-ai-ui.vercel.app/api/line-webhook",           // 申込ツール（アカウント判定）
];

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  // 両方に並行転送（どちらかが失敗してももう片方は続行）
  await Promise.all(
    FORWARD_URLS.map((url) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": signature,
        },
        body: rawBody,
      }).catch((err) =>
        console.error(`[line-relay] 転送エラー → ${url}:`, err)
      )
    )
  );

  // LINE には即座に 200 を返す
  return NextResponse.json({ ok: true });
}
