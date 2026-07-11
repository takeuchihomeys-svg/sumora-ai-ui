import { NextRequest, NextResponse } from "next/server";

// LINE送信系API（send-line-message / send-image-to-line / send-property-list /
// send-estimate-preview / notify-viewing / line-tasks/complete）の内部認証ガード。
//
// 【必要な環境変数】Vercel と .env.local の両方に同じ値を設定すること：
//   INTERNAL_API_SECRET             … サーバー側の検証用
//   NEXT_PUBLIC_INTERNAL_API_SECRET … クライアント（fetch）側の送信用
// 例: openssl rand -hex 32 で生成した同一のランダム文字列を両方に設定する。
//
// 未設定の場合は全リクエストを 401 で拒否する（fail-closed）。
export function requireInternalAuth(req: NextRequest): NextResponse | null {
  const auth = req.headers.get("authorization");
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
