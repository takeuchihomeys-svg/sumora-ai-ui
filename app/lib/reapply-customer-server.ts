// app/lib/reapply-customer-server.ts（サーバー専用・読むだけ・LLM なし）
// 「申込歴あり（再探し）」と戻った理由を DB から読む。決まりは reapply-customer.ts（純関数）。
//   1会話: loadReapplyInfo（画面のメモの帯・ブレインの材料）／たくさん: loadReapplyStates（やることリスト・ターゲットの並び）
import { loadPostApplyFacts, loadParallelSecondState, parallelEligible, type PostApplyFacts } from "@/app/lib/post-apply";
import { parallelSecondEnabled } from "@/app/lib/parallel-second";
import {
  resolveReapply, detectReturnPattern, staffPatternOf, reapplyMarkEnabled, buildReapplyBrainNote,
  PATTERN_WINDOW_BEFORE_MS, PATTERN_WINDOW_AFTER_MS,
  type ReapplyInfo, type ReapplyState, type PatternMsg, type PatternPicker,
} from "@/app/lib/reapply-customer";

// supabase-js の型をそのまま受けると TS2589 になるので、使う形だけを緩く受ける
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (table: string) => any };
type Res<T> = { data: T[] | null; error: { message: string } | null };

/** 戻った理由（スタッフの選択 → 会話・ピッカー）。読めない所は理由不明 */
async function patternFor(sb: Sb, conversationId: string, st: ReapplyState): Promise<ReapplyInfo> {
  const memo = (await sb.from("customer_memos").select("items").eq("conversation_id", conversationId).maybeSingle()) as { data: { items?: unknown } | null; error: unknown };
  const staff = staffPatternOf(Array.isArray(memo.data?.items) ? (memo.data!.items as Array<{ id?: string; text?: string; retiredAt?: string | null }>) : []);
  if (staff) return { reapply: true, returnedAt: st.returnedAt, pattern: staff, source: "staff" };
  const back = st.returnedAt ? Date.parse(st.returnedAt) : NaN;
  if (!Number.isFinite(back)) return { reapply: true, returnedAt: st.returnedAt, pattern: "unknown", source: "none" };
  const fromMs = Math.min(back - PATTERN_WINDOW_BEFORE_MS, st.lastApplyAt ? Date.parse(st.lastApplyAt) : Infinity);
  const fromIso = new Date(fromMs).toISOString(), toIso = new Date(back + PATTERN_WINDOW_AFTER_MS).toISOString();
  const [msgs, pk] = (await Promise.all([
    sb.from("messages").select("sender, text, created_at").eq("conversation_id", conversationId).gte("created_at", fromIso).lte("created_at", toIso)
      .order("created_at", { ascending: false }).limit(400),
    sb.from("aix_usage_logs").select("check_pattern, picker_choices, created_at").eq("conversation_id", conversationId).eq("aix_type", "property_check_result")
      .gte("created_at", fromIso).lte("created_at", st.returnedAt).limit(50),
  ])) as [Res<{ sender: string; text: string | null; created_at: string }>, Res<{ check_pattern: string | null; picker_choices: unknown; created_at: string }>];
  const m: PatternMsg[] = (msgs.data ?? []).map((r) => ({ sender: r.sender, text: r.text, createdAt: r.created_at }));
  const p: PatternPicker[] = pk.error ? [] : (pk.data ?? []).map((r) => ({ checkPattern: r.check_pattern, choices: r.picker_choices, createdAt: r.created_at }));
  const d = detectReturnPattern(m, st.returnedAt, p, st.lastApplyAt);
  return { reapply: true, returnedAt: st.returnedAt, pattern: d.pattern, source: d.pattern === "unknown" ? "none" : "auto" };
}

/** 1会話の申込歴あり（無ければ null・読めなければ null＝札を出さないだけ） */
export async function loadReapplyInfo(sb: Sb, conversationId: string, facts?: PostApplyFacts): Promise<ReapplyInfo | null> {
  if (!reapplyMarkEnabled()) return null;
  try {
    const st = resolveReapply(facts ?? await loadPostApplyFacts(sb, conversationId));
    if (!st.reapply) return null;
    return await patternFor(sb, conversationId, st);
  } catch (e) {
    console.warn("[reapply] 読めない:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** ブレインの材料（申込歴ありでなければ空文字） */
export async function reapplyBrainNoteFor(sb: Sb, conversationId: string): Promise<{ note: string; info: ReapplyInfo | null }> {
  const info = await loadReapplyInfo(sb, conversationId);
  return { note: info ? buildReapplyBrainNote(info) : "", info };
}

export type ReapplyConvRow = {
  id: string; status?: string | null; is_post_apply?: boolean | null; status_manual_back_at?: string | null; deepseek_cutoff_at?: string | null;
};

/**
 * たくさんの会話の申込歴あり（並び用）。戻しの印・切り替えの時刻がある会話だけ、申込へ押下・書類の最後の時刻を読む（フォームは読まない＝並びの目安）。
 *   withPattern の会話だけ戻った理由も読む（1会話ずつ・少数に限る）。読めない会話は申込歴なし扱い（並びを変えないだけ）
 */
export async function loadReapplyStates(sb: Sb, rows: ReadonlyArray<ReapplyConvRow>, opts: { withPattern?: (id: string) => boolean } = {}): Promise<Map<string, ReapplyInfo>> {
  const out = new Map<string, ReapplyInfo>();
  if (!reapplyMarkEnabled()) return out;
  const cand = rows.filter((r) => r.status_manual_back_at || r.deepseek_cutoff_at);
  if (!cand.length) return out;
  const pushBy = new Map<string, string>(), docBy = new Map<string, string>();
  const CH = 100;
  try {
    for (let i = 0; i < cand.length; i += CH) {
      const ids = cand.slice(i, i + CH).map((r) => r.id);
      const [push, doc] = (await Promise.all([
        sb.from("aix_usage_logs").select("conversation_id, created_at").in("conversation_id", ids).eq("aix_type", "application_push").order("created_at", { ascending: false }).limit(2000),
        sb.from("messages").select("conversation_id, created_at").in("conversation_id", ids).eq("sender", "customer").in("image_type", ["id_document", "income_document"]).order("created_at", { ascending: false }).limit(2000),
      ])) as [Res<{ conversation_id: string; created_at: string }>, Res<{ conversation_id: string; created_at: string }>];
      if (push.error || doc.error) throw new Error((push.error ?? doc.error)!.message);
      for (const r of push.data ?? []) if (!pushBy.has(r.conversation_id)) pushBy.set(r.conversation_id, r.created_at);
      for (const r of doc.data ?? []) if (!docBy.has(r.conversation_id)) docBy.set(r.conversation_id, r.created_at);
    }
  } catch (e) {
    console.warn("[reapply] 一覧の記録が読めない:", e instanceof Error ? e.message : String(e));
    return out;
  }
  for (const r of cand) {
    const f: PostApplyFacts = {
      status: r.status ?? null, isPostApply: r.is_post_apply === true, applicationPushAt: pushBy.get(r.id) ?? null, idDocumentAt: docBy.get(r.id) ?? null,
      statusManualBackAt: r.status_manual_back_at ?? null, deepseekCutoffAt: r.deepseek_cutoff_at ?? null,
    };
    const st = resolveReapply(f);
    if (!st.reapply) continue;
    // 2026-10-21 判定を1つにした: 2番手で申込中（並行で探す・post-apply.judgeParallelSecond）は申込歴ありにしない（1会話の loadReapplyInfo と同じ）。読めなければ今まで通り
    if (parallelSecondEnabled() && parallelEligible(f)) {
      try { if ((await loadParallelSecondState(sb, r.id, f)).parallel) continue; } catch { /* 読めない＝今まで通り */ }
    }
    if (opts.withPattern?.(r.id)) {
      try { out.set(r.id, await patternFor(sb, r.id, st)); continue; } catch { /* 理由は読めないだけ */ }
    }
    out.set(r.id, { reapply: true, returnedAt: st.returnedAt, pattern: "unknown", source: "none" });
  }
  return out;
}
