// app/api/deal-outcomes/confirm/route.ts — 会話画面の小さい帯（OutcomeConfirmBar）の材料と、スタッフが選んだ結果の記録（内部認証・LLM なし）
//   GET  ?conversation_id=… → { confirm: 申込から30日たった案件の確認（無ければ null）, nudge: 段階を申込にする促し（無ければ null） }
//   POST { conversation_id, episode_no, choice } → deal_outcomes に確定（locked）で残す（「まだ手続き中」は14日後にまた聞く）
//   竹内さんの決定（2026-10-08）②④。決まりは app/lib/outcome-confirm.ts・app/lib/apply-stage-nudge.ts。計画: memory/plan_outcome_ledger.md 9章
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { supabase } from "@/app/lib/supabase";
import { isTestConversation } from "@/app/lib/test-conversations";
import { pickConfirmCandidate, confirmPatch, isConfirmChoice, outcomeConfirmEnabled, type ConfirmCandidateRow } from "@/app/lib/outcome-confirm";
import { resolveApplyStageNudge, applyStageNudgeEnabled, applyStageNudgeText } from "@/app/lib/apply-stage-nudge";

export const maxDuration = 20;
const ID_RE = /^[0-9a-f-]{36}$/i;
const APPLYING = new Set(["applying", "application", "screening", "contract"]);
const COLS_NEW = "conversation_id, episode_no, applied_at, result, result_certainty, result_evidence, locked, staff_confirmed_at, confirm_snooze_until, property_name, room_no";
const COLS_OLD = "conversation_id, episode_no, applied_at, result, result_certainty, result_evidence, locked, property_name, room_no";

async function loadRows(conversationId: string): Promise<{ rows: ConfirmCandidateRow[]; newCols: boolean }> {
  const r = await supabase.from("deal_outcomes").select(COLS_NEW).eq("conversation_id", conversationId);
  if (!r.error) return { rows: (r.data ?? []) as ConfirmCandidateRow[], newCols: true };
  // 列（staff_confirmed_at・confirm_snooze_until）がまだ無い環境: 見せるだけ（選んでも書けないので出さない）
  const o = await supabase.from("deal_outcomes").select(COLS_OLD).eq("conversation_id", conversationId);
  return { rows: (o.data ?? []) as ConfirmCandidateRow[], newCols: false };
}

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const conversationId = (req.nextUrl.searchParams.get("conversation_id") ?? "").trim();
  if (!ID_RE.test(conversationId)) return NextResponse.json({ ok: false, error: "conversation_id required" }, { status: 400 });
  if (isTestConversation(conversationId)) return NextResponse.json({ ok: true, confirm: null, nudge: null }, { headers: { "Cache-Control": "no-store" } });
  const nowMs = Date.now();

  let confirm = null;
  if (outcomeConfirmEnabled(process.env)) {
    try {
      const { rows, newCols } = await loadRows(conversationId);
      const c = newCols ? pickConfirmCandidate(rows, nowMs) : null;
      if (c) confirm = c;
    } catch { /* 出さないだけ */ }
  }

  let nudge = null;
  if (applyStageNudgeEnabled(process.env)) {
    try {
      const [{ data: conv }, { data: hist }, { data: msgs }] = await Promise.all([
        supabase.from("conversations").select("status, status_manual_back_at").eq("id", conversationId).maybeSingle(),
        supabase.from("conversation_stage_history").select("from_status, to_status, changed_at").eq("conversation_id", conversationId).order("changed_at", { ascending: false }).limit(50),
        supabase.from("messages").select("sender, text, created_at").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(200),
      ]);
      const c = conv as { status: string | null; status_manual_back_at: string | null } | null;
      if (c) {
        const back = ((hist ?? []) as Array<{ from_status: string | null; to_status: string | null; changed_at: string }>)
          .find((h) => APPLYING.has(h.from_status ?? "") && !APPLYING.has(h.to_status ?? ""));
        const lastBackAt = [back?.changed_at ?? null, c.status_manual_back_at].filter((x): x is string => !!x).sort().pop() ?? null;
        const n = resolveApplyStageNudge({
          status: c.status, lastBackAt, nowMs,
          messages: ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })),
        });
        if (n) nudge = { ...n, text: applyStageNudgeText(n) };
      }
    } catch { /* 出さないだけ */ }
  }
  return NextResponse.json({ ok: true, confirm, nudge }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = (await req.json().catch(() => null)) as { conversation_id?: string; episode_no?: number; choice?: string } | null;
  const conversationId = String(body?.conversation_id ?? "").trim();
  const episodeNo = Number(body?.episode_no);
  if (!ID_RE.test(conversationId) || !Number.isInteger(episodeNo) || episodeNo < 1 || !isConfirmChoice(body?.choice)) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  if (isTestConversation(conversationId)) return NextResponse.json({ ok: false, error: "test conversation" }, { status: 400 });
  const nowMs = Date.now();
  const { rows, newCols } = await loadRows(conversationId);
  if (!newCols) return NextResponse.json({ ok: false, error: "columns missing (migrate-schema)" }, { status: 409 });
  // 今も確認の候補か（二重押し・別の端末で選んだ後は書かない）
  const c = pickConfirmCandidate(rows, nowMs);
  if (!c || c.episodeNo !== episodeNo) return NextResponse.json({ ok: false, error: "not a candidate" }, { status: 409 });
  const { error } = await supabase.from("deal_outcomes").update(confirmPatch(body!.choice as Parameters<typeof confirmPatch>[0], nowMs))
    .eq("conversation_id", conversationId).eq("episode_no", episodeNo);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  console.log(JSON.stringify({ tag: "outcome-confirm", conversationId, episodeNo, choice: body!.choice, current: c.current, days: c.daysSinceApplied }));
  return NextResponse.json({ ok: true });
}
