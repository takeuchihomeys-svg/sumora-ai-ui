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
import { supabase } from "@/app/lib/supabase";

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
