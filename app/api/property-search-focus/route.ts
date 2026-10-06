// app/api/property-search-focus/route.ts — 会話画面の「🔍 物件検索」の印（このお客様を拡張のお客様の一覧の一番上へ）
//
// 2026-10-06 竹内「ここ（会話の上の状態の帯）広げたところに物件検索ボタンを出す。そうすると拡張ツール繰り上げられるようにする」
//   「スマホで押しても連携して拡張ツールのお客さんの一番上に繰り上がるようにする」
//
//   POST { conversation_id }（内部認証・画面の帯のボタン）… 会話に紐付いたお客様に印（押した時刻・端末）を置く（お客様ごとに1行・上書き）
//   GET ?conversation_id=…（内部認証）… 帯のボタンの表示用: 紐付いたお客様・今の印・条件の最後の更新（言い直しが登録の条件に入ったか）
//   GET（conversation_id なし・認証なし）… 拡張の軽い取り直し: 24時間以内の印の一覧（お客様の id と時刻だけ。
//       拡張は /api/property-customers も認証なしで読んでいる＝見える物は増えない）
//   印を消す書き込みはしない（拡張の search-focus.js が「押した後に検索した・送った・24時間」で効いていない印にする）。
//   表 property_search_focus は migrate-schema に追記（本番に無い間は POST が table-missing を返し、画面は「印の表が未作成」と出す）
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { FOCUS_TTL_MS, deviceOf, lastConditionChange, type ConditionHistoryRow } from "@/app/lib/search-focus";

export const maxDuration = 15;

const UUID_RE = /^[0-9a-f-]{36}$/i;

function isMissingTable(msg: string | undefined | null): boolean {
  return /property_search_focus/.test(String(msg ?? "")) && /does not exist|schema cache|Could not find/i.test(String(msg ?? ""));
}

async function resolveCustomer(conversationId: string) {
  const { data: conv } = await supabase.from("conversations").select("id, property_customer_id, customer_name").eq("id", conversationId).maybeSingle();
  const pcId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
  if (!pcId) return { conv, customer: null as null | { id: string; customer_name: string | null; status: string | null } };
  const { data: pc } = await supabase.from("property_customers").select("id, customer_name, status").eq("id", pcId).maybeSingle();
  return { conv, customer: (pc as { id: string; customer_name: string | null; status: string | null } | null) ?? null };
}

export async function GET(req: NextRequest) {
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();

  // 拡張の軽い取り直し（認証なし・24時間以内の印だけ）
  if (!conversationId) {
    const since = new Date(Date.now() - FOCUS_TTL_MS).toISOString();
    const { data, error } = await supabase
      .from("property_search_focus")
      .select("property_customer_id, requested_at, requested_by, device")
      .gte("requested_at", since)
      .order("requested_at", { ascending: false })
      .limit(200);
    if (error) return NextResponse.json({ ok: false, error: isMissingTable(error.message) ? "table-missing" : error.message }, { status: 200, headers: { "Cache-Control": "no-store" } });
    const marks = (data ?? []).map((r) => ({ property_customer_id: r.property_customer_id, at: r.requested_at, by: r.requested_by ?? null, device: r.device ?? null }));
    return NextResponse.json({ ok: true, marks }, { headers: { "Cache-Control": "no-store" } });
  }

  const authError = requireInternalAuth(req);
  if (authError) return authError;
  if (!UUID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  const { customer } = await resolveCustomer(conversationId);
  if (!customer) return NextResponse.json({ ok: true, customer: null, focus: null, lastConditionChange: null }, { headers: { "Cache-Control": "no-store" } });

  const [focusRes, histRes] = await Promise.all([
    supabase.from("property_search_focus").select("requested_at, requested_by, device").eq("property_customer_id", customer.id).maybeSingle(),
    supabase.from("property_condition_history").select("changed_field, old_value, new_value, source_message_id, created_at")
      .eq("property_customer_id", customer.id).order("created_at", { ascending: false }).limit(20),
  ]);
  const focusRow = focusRes.data as { requested_at: string; requested_by: string | null; device: string | null } | null;
  return NextResponse.json({
    ok: true,
    customer: { id: customer.id, name: customer.customer_name, status: customer.status },
    focus: focusRow ? { at: focusRow.requested_at, by: focusRow.requested_by, device: focusRow.device } : null,
    tableMissing: !!(focusRes.error && isMissingTable(focusRes.error.message)),
    lastConditionChange: lastConditionChange((histRes.data ?? []) as ConditionHistoryRow[]),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = (await req.json().catch(() => ({}))) as { conversation_id?: string; by?: string };
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";
  if (!UUID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  const { customer } = await resolveCustomer(conversationId);
  if (!customer) return NextResponse.json({ ok: false, error: "no-customer" }, { status: 404 });

  const row = {
    property_customer_id: customer.id,
    conversation_id: conversationId,
    requested_at: new Date().toISOString(),
    // 押した人: アプリにスタッフのログインが無いので、画面が渡した名前（今は無し）か端末だけ
    requested_by: typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 40) : null,
    device: deviceOf(req.headers.get("user-agent")),
  };
  const { error } = await supabase.from("property_search_focus").upsert(row, { onConflict: "property_customer_id" });
  if (error) {
    const missing = isMissingTable(error.message);
    return NextResponse.json({ ok: false, error: missing ? "table-missing" : error.message }, { status: missing ? 503 : 500 });
  }
  return NextResponse.json({
    ok: true,
    customer: { id: customer.id, name: customer.customer_name },
    focus: { at: row.requested_at, by: row.requested_by, device: row.device },
  });
}
