// app/lib/post-apply-brain-gate-server.ts — 申込以降のブレインの関所（記録を読む側）。判定は post-apply-brain-gate.ts の純関数
//
// 2026-10-07 竹内さんの決定（設計知見 d23150a0）「申込以降は別のツールで対応しているので、申込中・審査中は否決・取り消し・クレームの時だけ回す」。
// 2026-10-18 本番14日の調べ: 関所は status（申込中・審査中）しか見ていなかったので、AIX【申込へ】を押した後も status が提案中・内覧のまま遅れている会話は
//   お客様の発言のたびに sweep（5〜10分後）がブレインを全部回していた（sweep 145回 $9.6 のうち、記録では申込以降）。
//   bg-async は記録（申込へ押下・本人確認書類・印＝resolvePostApply）で申込以降と見て下書きも止めているのに、sweep とブレイン本体は status だけだった。
//   → 同じ記録の判定で「申込以降」なら関所に入れる（status が遅れている時は lagging＝申込が流れた動きがあれば回す側）。
//   戻す: BRAIN_POST_APPLY_RECORDS=off（status だけの今まで）。関所ごと戻す: BRAIN_POST_APPLY_GATE=off
import { supabase } from "@/app/lib/supabase-server";
import { loadPostApplyFacts, resolvePostApply, parallelSecondActive } from "@/app/lib/post-apply";
import { PARALLEL_STATUSES, parallelSecondEnabled } from "@/app/lib/parallel-second";
import { decidePostApplyBrainGate, POST_APPLY_GATE_STATUSES, postApplyAnchorAt, type GateMsg } from "@/app/lib/post-apply-brain-gate";

export type PostApplyBrainGateResult = { run: boolean; reason: string; lagging: boolean; anchorAt: string | null };

const off = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "off";

/**
 * 申込以降の関所。null＝関所に入らない（申込前・スイッチが切れている）＝今まで通り回す。
 * 記録が読めない時は例外を投げる（呼び出し側は回す側に倒す＝今まで通り）。
 */
export async function loadPostApplyBrainGate(conversationId: string, status: string | null, env: Record<string, string | undefined> = process.env): Promise<PostApplyBrainGateResult | null> {
  if (off(env.BRAIN_POST_APPLY_GATE)) return null;
  const inGate = POST_APPLY_GATE_STATUSES.has((status ?? "").trim());
  let anchorAt: string | null = null;
  let idDocumentAt: string | null = null;
  // 2026-10-21 竹内さんの決定（ec4d5990）: 2番手で申込中（並行で探す）と明示的に決まった会話は関所に入れない（並行して物件を探すのでブレインを回す）。
  //   読めなければ今まで通り関所に入れる。戻す REAPPLY_PARALLEL_2ND=off
  if (inGate && parallelSecondEnabled(env) && PARALLEL_STATUSES.has((status ?? "").trim())) {
    const pf = await loadPostApplyFacts(supabase, conversationId).catch(() => null);
    if (pf && parallelSecondActive(pf, env)) return null;
  }
  if (inGate) {
    const { data: pushRow, error } = await supabase.from("aix_usage_logs").select("created_at")
      .eq("conversation_id", conversationId).eq("aix_type", "application_push")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`post-apply-gate: aix_usage_logs: ${error.message}`);
    anchorAt = (pushRow?.created_at as string | undefined) ?? null;
  } else {
    if (off(env.BRAIN_POST_APPLY_RECORDS)) return null;
    const facts = await loadPostApplyFacts(supabase, conversationId);
    if (!resolvePostApply(facts).postApply) return null;
    if (parallelSecondActive(facts, env)) return null; // 2番手で並行して探している（上と同じ）
    anchorAt = postApplyAnchorAt(facts.applicationPushAt, facts.idDocumentAt);
    idDocumentAt = facts.idDocumentAt ?? null;
  }
  let q = supabase.from("messages").select("sender, text, created_at").eq("conversation_id", conversationId);
  if (anchorAt) q = q.gte("created_at", anchorAt);
  const [{ data: gm, error: gmErr }, presses] = await Promise.all([
    q.order("created_at", { ascending: false }).limit(anchorAt ? 300 : 60),
    inGate
      ? Promise.resolve({ data: [] as Array<{ aix_type: string | null; created_at: string }>, error: null })
      : (anchorAt
        ? supabase.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", conversationId).gt("created_at", anchorAt).order("created_at", { ascending: true }).limit(100)
        : supabase.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(30)),
  ]);
  if (gmErr) throw new Error(`post-apply-gate: messages: ${gmErr.message}`);
  if (presses.error) throw new Error(`post-apply-gate: aix_usage_logs: ${presses.error.message}`);
  const g = decidePostApplyBrainGate({
    status: inGate ? status : "proposing",
    lagging: !inGate,
    msgs: ((gm ?? []) as GateMsg[]).slice().reverse(),
    presses: (presses.data ?? []) as Array<{ aix_type: string | null; created_at: string }>,
    applicationPushAt: anchorAt,
    idDocumentAt,
    env,
  });
  return { run: g.run, reason: g.reason, lagging: !inGate, anchorAt };
}
