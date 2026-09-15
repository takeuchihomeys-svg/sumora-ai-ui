// app/api/viewing-report/route.ts
// 内覧の内容（内覧に行ったスタッフが分かったこと）の読み書き。内覧後の挨拶の画面から使う。
// 2026-09-15 竹内（yasuki 事例）: 会話に書かれない事情（誰が契約するか・誰と相談しているか・気に入った物件）を、ブレイン・返信生成・AIX の前提にする
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { recordViewingReport, loadViewingReports } from "@/app/lib/viewing-report-store";
import { VIEWING_REPORT_MAX_CHARS } from "@/app/lib/viewing-report";

/** GET ?conversation_id= → 最新の内覧の内容（画面の入力欄の初期値。作り直しで入力が消えないように） */
export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = req.nextUrl.searchParams.get("conversation_id");
  if (!conversationId) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  const [latest] = await loadViewingReports(conversationId, 1);
  return NextResponse.json({ ok: true, report: latest ?? null });
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = await req.json() as { conversation_id?: string; customer_name?: string | null; report?: string; property_name?: string | null };
  if (!body.conversation_id) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  if ((body.report ?? "").length > VIEWING_REPORT_MAX_CHARS * 2) {
    return NextResponse.json({ ok: false, error: `内覧の内容は${VIEWING_REPORT_MAX_CHARS}字までにしてください` }, { status: 400 });
  }
  const r = await recordViewingReport({
    conversationId: body.conversation_id, customerName: body.customer_name ?? null,
    report: body.report ?? "", propertyName: body.property_name ?? null,
  });
  if (!r.ok) return NextResponse.json(r, { status: r.error === "内覧の内容が空です" ? 400 : 500 });
  return NextResponse.json(r);
}
