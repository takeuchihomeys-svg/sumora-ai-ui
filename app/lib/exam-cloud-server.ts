// app/lib/exam-cloud-server.ts — 試験をクラウドで流す口の Sandbox の操作（作業員1・2026-11-04・既定 off）
//   関数（Vercel の上）だけが呼ぶ＝SDK の認証は OIDC で自動。鍵はこの関数の process.env から通信の口に渡すだけ（返さない・記録しない）
import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@vercel/sandbox";
import { examCloudOn, examCloudAuthorized, brokeredPolicy, vmEnv, EXAM_CLOUD_TIMEOUT_MS, RUN_DIR } from "@/app/lib/exam-cloud";

/** 口の門: EXAM_CLOUD=on・合言葉。通らなければ応答を返す */
export function examCloudGate(req: NextRequest): NextResponse | null {
  if (!examCloudOn()) return NextResponse.json({ ok: false, error: "EXAM_CLOUD が off" }, { status: 403 });
  if (!examCloudAuthorized(req.headers.get("authorization"))) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  return null;
}

export async function createExamSandbox(extraEnv: Record<string, string>): Promise<{ name: string }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const deepseekKey = (process.env.LLM_ALT_DEEPSEEK_KEY ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  const openaiKey = (process.env.OPENAI_API_KEY ?? "").replace(/^﻿/, "");
  if (!supabaseUrl || !supabaseKey || !deepseekKey) throw new Error("関数の環境変数に Supabase のサーバーの鍵か DeepSeek の鍵が無い");
  const sb = await Sandbox.create({
    image: "vercel/sandbox/node:24",
    resources: { vcpus: 4 },
    timeout: EXAM_CLOUD_TIMEOUT_MS,
    persistent: false,
    networkPolicy: brokeredPolicy({ supabaseUrl, supabaseKey, deepseekKey, openaiKey }),
    env: vmEnv(supabaseUrl, extraEnv),
    tags: { kind: "exam-cloud" },
  });
  // 作った後の支度で落ちたら、その VM を必ず止める（1回目は止め損ねて3台が残った＝MCP で止めた）
  try {
    const mk = await sb.runCommand("mkdir", ["-p", `${RUN_DIR}/up`, `${RUN_DIR}/out`]);
    if (mk.exitCode !== 0) throw new Error(`mkdir: ${(await mk.stderr()).slice(0, 200)}`);
  } catch (e) { await sb.stop().catch(() => {}); throw e; }
  return { name: sb.name };
}

export async function getExamSandbox(name: string): Promise<Sandbox> {
  return Sandbox.get({ name, resume: false } as Parameters<typeof Sandbox.get>[0]);
}
