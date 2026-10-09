// app/api/contact-promise/undated/route.ts — 日付の無い連絡の約束（「来年再相談」「時期が来ましたらご案内」）の連絡の日をスタッフが選んでカレンダーに入れる（内部認証・LLM なし）
//   GET  ?conversation_id=… → { pending: { sentence, sentAt } | null }（会話の画面の約束のバナーに「連絡の日を入れてください」）
//   POST { conversation_id, date: "YYYY-MM-DD" } → calendar_events に【必ず】の連絡の日の行（contact-promise.contactEventRow と同じ形）を入れる
//   2026-10-08 竹内さん「約束してカレンダーに入れる」＝日付の無い約束もカレンダーへ。日付は推測で作らない（スタッフが選ぶ）。
//   決まりは app/lib/contact-promise.ts（pendingUndatedPromise・undatedPromiseToContact）。戻す: CONTACT_PROMISE_UNDATED=off
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { supabase } from "@/app/lib/supabase";
import { pendingUndatedPromise, undatedPromiseToContact, contactEventRow, UNDATED_FROM_MARK, type UndatedPromise } from "@/app/lib/contact-promise";

export const maxDuration = 20;
const ID_RE = /^[0-9a-f-]{36}$/i;
const off = () => (process.env.CONTACT_PROMISE_UNDATED ?? "").toLowerCase() === "off";

async function loadPending(conversationId: string, nowMs: number): Promise<UndatedPromise | null> {
  const [{ data: msgs }, { data: rows }] = await Promise.all([
    supabase.from("messages").select("sender, text, created_at").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(60),
    supabase.from("calendar_events").select("notes, created_at").eq("conversation_id", conversationId).like("notes", "【必ず】%【連絡日%").limit(30),
  ]);
  const ms = ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).reverse().map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));
  return pendingUndatedPromise(ms, (rows ?? []) as Array<{ notes: string | null; created_at: string | null }>, nowMs);
}

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();
  if (!ID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  if (off()) return NextResponse.json({ ok: true, pending: null });
  try {
    return NextResponse.json({ ok: true, pending: await loadPending(conversationId, Date.now()) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: true, pending: null });
  }
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  if (off()) return NextResponse.json({ ok: false, error: "off" }, { status: 409 });
  const body = (await req.json().catch(() => null)) as { conversation_id?: string; date?: string } | null;
  const conversationId = String(body?.conversation_id ?? "").trim();
  const date = String(body?.date ?? "").trim();
  if (!ID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  const nowMs = Date.now();
  // 今も入れる候補か（二重押し・別の端末で入れた後は入れない）
  const p = await loadPending(conversationId, nowMs);
  if (!p) return NextResponse.json({ ok: false, error: "not pending" }, { status: 409 });
  const promise = undatedPromiseToContact(p, date, nowMs);
  if (!promise) return NextResponse.json({ ok: false, error: "date must be today or later (YYYY-MM-DD)" }, { status: 400 });
  const { data: conv } = await supabase.from("conversations").select("customer_name").eq("id", conversationId).maybeSingle();
  const row = contactEventRow(promise, { customerName: (conv?.customer_name as string | null) ?? null, conversationId, sentAt: p.sentAt });
  row.notes = `${row.notes}\n${UNDATED_FROM_MARK}`;
  const { error } = await supabase.from("calendar_events").insert(row);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  console.log(JSON.stringify({ tag: "contact-promise:undated-scheduled", conversationId, date, sentence: p.sentence.slice(0, 60) }));
  return NextResponse.json({ ok: true, title: row.title, start_at: row.start_at });
}
