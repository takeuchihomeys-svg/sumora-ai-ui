// app/api/customer-memo/route.ts — お客様のメモ（人の営業のメモ帳）を会話の画面で読む・スタッフが直す（内部認証・LLM なし）
//   GET  ?conversation_id=… → { rows: [{ id, kind, label, text, source, origin, locked }], mood: { hint, changes, prevEmotions } | null, llmAt }
//   POST { conversation_id, op: "add"|"update"|"retire"|"hide_rule"|"unhide_rule", id?, kind?, text?, reason? }
//     スタッフが付けた・直した行は手で付けた印（locked）＝DeepSeek の差分で書き換え・外さない。決まった計算の「もう伝えた」は hide_rule で外す。
//   決まりは app/lib/customer-memo.ts・customer-memo-server.ts。戻す: NEXT_PUBLIC_CUSTOMER_MEMO=off（画面）・CUSTOMER_MEMO=off
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { customerMemoView, applyStaffMemoEdit } from "@/app/lib/customer-memo-server";
import { LLM_MEMO_KINDS, type MemoKind } from "@/app/lib/customer-memo";

export const maxDuration = 20;
const ID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();
  if (!ID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await customerMemoView(conversationId)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: true, rows: [], mood: null, llmAt: null, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const b = (await req.json().catch(() => null)) as { conversation_id?: string; op?: string; id?: string; kind?: string; text?: string; reason?: string } | null;
  const conversationId = String(b?.conversation_id ?? "").trim();
  if (!ID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  const text = String(b?.text ?? "").trim().slice(0, 60);
  const id = String(b?.id ?? "").trim();
  let r: { ok: boolean; error?: string };
  switch (b?.op) {
    case "add":
      // 2026-10-09 決め手の残り（decide_gap）はスタッフが手で足せる（DeepSeek の読み取りには出させない）
      if (!text || !(LLM_MEMO_KINDS.includes(b.kind as MemoKind) || b.kind === "decide_gap")) return NextResponse.json({ ok: false, error: "kind/text required" }, { status: 400 });
      r = await applyStaffMemoEdit(conversationId, { op: "add", kind: b.kind as MemoKind, text }); break;
    case "update":
      if (!id || !text) return NextResponse.json({ ok: false, error: "id/text required" }, { status: 400 });
      r = await applyStaffMemoEdit(conversationId, { op: "update", id, text }); break;
    case "retire":
      if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      r = await applyStaffMemoEdit(conversationId, { op: "retire", id, reason: String(b.reason ?? "").slice(0, 60) || undefined }); break;
    case "hide_rule": case "unhide_rule":
      if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      r = await applyStaffMemoEdit(conversationId, { op: b.op, id }); break;
    default: return NextResponse.json({ ok: false, error: "op" }, { status: 400 });
  }
  if (r.ok) console.log(JSON.stringify({ tag: "customer-memo:staff-edit", conversationId, op: b?.op, id: id || null }));
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
