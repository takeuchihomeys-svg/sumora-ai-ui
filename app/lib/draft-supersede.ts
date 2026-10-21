// app/lib/draft-supersede.ts
// 下書きを保存する直前に「答えたお客様発言より新しい発言が届いていないか」を確かめる（サーバー専用）。
//
// 2026-09-13 監査 抜け2: 生成（最大180秒）の途中にお客様の2通目が届くと、
//   webhook は draft_pending_at を立てるが、生成中の印（draft_attempted_at）があるので2本目の bg-async は「生成中」でスキップ、
//   その後1通目の生成が ai_draft を保存して draft_pending_at も消すため、2通目にはブレインも下書きも作られなかった
//   （お客様が20秒〜4分で続けて送る往復は全体の27%）。
//   新しい発言があれば1通目向けの下書きは保存せず、生成中の印を外して draft_pending_at を残す → cron（generate-pending-drafts）が
//   ブレイン（brain_analyzed_at < updated_at）→ 2通目まで含めた下書きを作り直す。
//   保存する3か所（generate-reply・bg-async・cron）が同じ判定を使う（どこか1か所でも保存すると2通目の下書きが作られない）。
import { supabase } from "@/app/lib/supabase-server";
import { isTrivialAckText, ackExemptEnabled } from "@/app/lib/stale-reply";

/** 同じ秒の書き込みの丸め（答えた発言そのものを「新しい」と誤判定しない） */
const SUPERSEDE_TOLERANCE_MS = 1_000;

/** answeredAt（生成が答えた最新のお客様発言の時刻）より新しいお客様発言があればその時刻、なければ null。判定できない時は null（従来どおり保存） */
export async function newerCustomerMessageAfter(conversationId: string, answeredAt: string | null | undefined): Promise<string | null> {
  const answeredMs = answeredAt ? Date.parse(answeredAt) : NaN;
  if (!Number.isFinite(answeredMs)) return null;
  try {
    const { data } = await supabase.from("messages").select("created_at")
      .eq("conversation_id", conversationId).eq("sender", "customer")
      .gt("created_at", new Date(answeredMs + SUPERSEDE_TOLERANCE_MS).toISOString())
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    return (data?.created_at as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** 下書きの保存を見送る時の更新（生成中の印を外す。draft_pending_at は触らない＝webhook が2通目で立てた印を残す） */
export const SUPERSEDED_DRAFT_UPDATE = { draft_attempted_at: null } as const;

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-20 竹内さん（設計知見 P1 54ec8c71「返信を送る前にお客様から新しい LINE が来たら、その新しい発言に返信する」）
//   上の判定は「保存の直前」に1回だけ見ていた。判定と保存の間（数十ms〜）にお客様の発言が届くと、webhook は ai_draft を空にした後で
//   この保存が前の発言向けの下書きを書き、draft_pending_at も消すため、次の作り直しが起きず古い下書きが入力欄・自動返信に残った。
//   保存の後にもう一度見て、新しい発言があれば「その下書きのままなら」消して作り直しの印（draft_pending_at）を戻す。
//   戻す: STALE_DRAFT_GUARD=off
// ─────────────────────────────────────────────────────────────────────────────
export function staleDraftGuardOn(): boolean {
  return (process.env.STALE_DRAFT_GUARD ?? "on").trim().toLowerCase() !== "off";
}

/**
 * 下書きを保存した直後に呼ぶ。answeredAt より新しいお客様の発言があれば、保存した下書きのまま（スタッフが表示・編集していない）の時だけ
 * ai_draft を空に戻し、draft_pending_at を新しい発言の時刻にする（cron が新しい発言まで含めて作り直す）。戻り値は新しい発言の時刻 or null。
 */
export async function revertDraftIfSupersededAfterSave(
  conversationId: string, answeredAt: string | null | undefined, savedDraft: string, caller: string,
): Promise<string | null> {
  if (!staleDraftGuardOn() || !savedDraft.trim()) return null;
  const newer = await newerCustomerMessageAfter(conversationId, answeredAt);
  if (!newer) return null;
  try {
    const { error } = await supabase.from("conversations")
      .update({ ai_draft: null, draft_pending_at: newer, draft_attempted_at: null })
      .eq("id", conversationId).eq("ai_draft", savedDraft);
    if (error) console.warn("[draft-supersede] revert after save failed:", conversationId, error.message);
  } catch (e) {
    console.warn("[draft-supersede] revert after save failed:", conversationId, e instanceof Error ? e.message : String(e));
  }
  console.log(JSON.stringify({ tag: "draft:superseded-after-save", conversationId, answeredAt: answeredAt ?? null, newerAt: newer, caller }));
  return newer;
}

/**
 * 2026-10-20 竹内さん（おすすめで決定）: answeredAt より新しいお客様の発言のうち「短いお礼・了承だけ」でない物（いちばん新しい物）。
 * 送信 API の 409・手で予約した文の取り消しが使う（画面の確かめと同じ線 = stale-reply.ts isTrivialAckText）。
 * STALE_ACK_EXEMPT=off の時はお礼・了承も数える（newerCustomerMessageAfter と同じ）。判定できない時は null（止めない）。
 */
export async function newerSubstantiveCustomerMessageAfter(conversationId: string, answeredAt: string | null | undefined): Promise<{ at: string; text: string } | null> {
  const answeredMs = answeredAt ? Date.parse(answeredAt) : NaN;
  if (!Number.isFinite(answeredMs)) return null;
  const exempt = ackExemptEnabled(process.env.STALE_ACK_EXEMPT);
  try {
    const { data } = await supabase.from("messages").select("created_at, text")
      .eq("conversation_id", conversationId).eq("sender", "customer")
      .gt("created_at", new Date(answeredMs + SUPERSEDE_TOLERANCE_MS).toISOString())
      .order("created_at", { ascending: false }).limit(30);
    for (const r of (data ?? []) as Array<{ created_at: string; text: string | null }>) {
      if (exempt && isTrivialAckText(r.text)) continue;
      return { at: r.created_at, text: (r.text ?? "").trim() };
    }
    return null;
  } catch {
    return null;
  }
}
