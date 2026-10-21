// app/api/customer-memo/route.ts — お客様のメモ（人の営業のメモ帳）を会話の画面で読む・スタッフが直す（内部認証・LLM なし）
//   GET  ?conversation_id=… → { rows: [{ id, kind, label, text, source, origin, locked }], mood: { hint, changes, prevEmotions } | null, llmAt }
//   POST { conversation_id, op: "add"|"update"|"retire"|"hide_rule"|"unhide_rule", id?, kind?, text?, reason? }
//     スタッフが付けた・直した行は手で付けた印（locked）＝DeepSeek の差分で書き換え・外さない。決まった計算の「もう伝えた」は hide_rule で外す。
//   決まりは app/lib/customer-memo.ts・customer-memo-server.ts。戻す: NEXT_PUBLIC_CUSTOMER_MEMO=off（画面）・CUSTOMER_MEMO=off
//   2026-10-21 竹内さんの決定（70193195・c2909936）: GET に申込歴あり（再探し）と戻った理由 reapply: { pattern, label, badge, source, returnedAt } | null を足す。
//     POST { op: "set_reapply_pattern", pattern: "screening_denied"|"lost_to_first"|"switched"|"unknown"|null } でスタッフが理由を選ぶ（null で自動の読みに戻す）
//   2026-10-21 竹内さんの決定（ec4d5990）: GET に 2番手で申込中（並行で探す）parallel: { active, eligible, source, label } | null（今も申込中の会話だけ）。
//     POST { op: "set_parallel_2nd", on: true|false|null } でスタッフが選ぶ（null で自動の読みに戻す）
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { customerMemoView, applyStaffMemoEdit, setReapplyPatternMemo, setParallelSecondMemo } from "@/app/lib/customer-memo-server";
import { loadPostApplyFacts, loadParallelSecondState, parallelEligible } from "@/app/lib/post-apply";
import { PARALLEL_2ND_LABEL, parallelSecondEnabled } from "@/app/lib/parallel-second";
import { LLM_MEMO_KINDS, CALL_MEMO_CHARS, type MemoKind } from "@/app/lib/customer-memo";
import { supabase } from "@/app/lib/supabase";
import { loadReapplyInfo } from "@/app/lib/reapply-customer-server";
import { RETURN_PATTERNS, RETURN_PATTERN_LABEL, reapplyBadgeText, type ReturnPattern } from "@/app/lib/reapply-customer";

async function reapplyView(conversationId: string) {
  const info = await loadReapplyInfo(supabase, conversationId);
  return info ? { pattern: info.pattern, label: RETURN_PATTERN_LABEL[info.pattern], badge: reapplyBadgeText(info), source: info.source, returnedAt: info.returnedAt } : null;
}

/** 2番手で申込中（並行で探す）の札（今も申込中の会話だけ・読めなければ null＝出さない） */
async function parallelView(conversationId: string) {
  if (!parallelSecondEnabled()) return null;
  const facts = await loadPostApplyFacts(supabase, conversationId);
  if (!parallelEligible(facts)) return null;
  const st = await loadParallelSecondState(supabase, conversationId, facts);
  return { active: st.parallel, eligible: true, source: st.source, label: PARALLEL_2ND_LABEL };
}

export const maxDuration = 20;
const ID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();
  if (!ID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  try {
    const [view, reapply, parallel] = await Promise.all([customerMemoView(conversationId), reapplyView(conversationId).catch(() => null), parallelView(conversationId).catch(() => null)]);
    return NextResponse.json({ ok: true, ...view, reapply, parallel }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: true, rows: [], mood: null, llmAt: null, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const b = (await req.json().catch(() => null)) as { conversation_id?: string; op?: string; id?: string; kind?: string; text?: string; reason?: string; pattern?: string | null; on?: boolean | null } | null;
  const conversationId = String(b?.conversation_id ?? "").trim();
  if (!ID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  if (b?.op === "set_reapply_pattern") {
    const p = b.pattern ?? null;
    if (p !== null && !RETURN_PATTERNS.includes(p as ReturnPattern)) return NextResponse.json({ ok: false, error: "pattern" }, { status: 400 });
    const r = await setReapplyPatternMemo(conversationId, p as ReturnPattern | null);
    if (r.ok) console.log(JSON.stringify({ tag: "customer-memo:reapply-pattern", conversationId, pattern: p }));
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  }
  if (b?.op === "set_parallel_2nd") {
    const on = b.on === true ? true : b.on === false ? false : null;
    const r = await setParallelSecondMemo(conversationId, on);
    if (r.ok) console.log(JSON.stringify({ tag: "customer-memo:parallel-2nd", conversationId, on }));
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  }
  // 2026-10-14（37af1885）: 電話で分かった事（call）は200字まで（AIX【電話する→電話終了後】から）
  const text = String(b?.text ?? "").trim().slice(0, b?.kind === "call" || b?.op === "update" ? CALL_MEMO_CHARS : 60); // update は行の種類で applyMemoOps が切る
  const id = String(b?.id ?? "").trim();
  let r: { ok: boolean; error?: string };
  switch (b?.op) {
    case "add":
      // 2026-10-09 決め手の残り（decide_gap）・2026-10-14 電話で分かった事（call）はスタッフが手で足せる（DeepSeek の読み取りには出させない）
      if (!text || !(LLM_MEMO_KINDS.includes(b.kind as MemoKind) || b.kind === "decide_gap" || b.kind === "call")) return NextResponse.json({ ok: false, error: "kind/text required" }, { status: 400 });
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
