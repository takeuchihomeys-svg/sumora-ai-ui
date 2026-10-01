// app/api/test/llm-mode/route.ts — 開発サーバが「テストとして」起動しているかを答える（手元専用・本番では 404）
//
// 2026-10-02 竹内「テストはテストやで」: HTTP で開発サーバを叩く YUMA のテストスクリプト（約40本）は、サーバが
//   LLM_TEST_MODE=deepseek-all／LLM_TEST_FINAL_CLAUDE=1 のどちらで起動しているかを確かめずに送っていた（印なしの開発サーバ＝本番と同じ
//   Claude の判定・最終チェックが黙って走る／本番の URL に向けた物もあった）。スクリプトの共通の部品（scripts/lib/dev-server-test-guard.ts）が
//   送る前にここを読み、テストの印が無ければ止める。
// 本番では動かない: isTestModeAllowed（VERCEL・VERCEL_ENV・VERCEL_URL・NODE_ENV=production のどれかで false）なら 404 を返し、何も読まない。
// 返すのは印の値だけ（鍵・会話の中身は返さない）。
import { NextResponse } from "next/server";
import { isTestModeAllowed, readTestRun, readAllowClaude, usageEnvLabel } from "@/app/lib/llm-test-mode";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isTestModeAllowed(process.env)) return new NextResponse(null, { status: 404 });
  return NextResponse.json({
    run: readTestRun(process.env),
    envLabel: usageEnvLabel(process.env),
    allowClaude: [...readAllowClaude(process.env)],
    sonnetModel: process.env.CLAUDE_SONNET_MODEL ?? null,
    pid: process.pid,
  }, { headers: { "cache-control": "no-store" } });
}
