import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import {
  pairBrainDecisions, aggregateBrainAixFeedback, collapsePresses, customerTurnBeforePress, sceneEvidenceForTurn,
  normalizeAixForMatch, type BrainDecisionRow, type AixPressRow, type ScenePress,
} from "@/app/lib/brain-aix-feedback";

// ── brain-aix-eval: ブレインの AIX 判断 × スタッフが実際に押した AIX（2026-09-12 竹内方針「AIX のセットはブレインが判断する」統合設計 段2）──
// ブレイン側の cron。aix_usage_logs は読むだけ（AIX の学習パスのコードには触れない）。
//   1) brain_decision_logs の各判断を「次の判断または24時間まで」に最初に押された AIX と対にして actual_* / matched を書き戻す
//   2) action 別 / action|check_pattern 別 / decision_source 別 / 場面別（scene_staff）の一致率と「代わりに押された AIX」を
//      brain_aix_feedback に upsert（n>=10 だけ）。ブレイン（brain-core analyzeConversation）がプロンプトの実績欄と降格ゲートで読む
// trigger_action_rules には書かない（trigger_rule_category が keyword_rule に分類し n-gram キーワードに混ざるため）。

export const maxDuration = 300;

const WINDOW_DAYS = 30;
const PAGE = 1000;

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, cap = 20000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; await fn(items[idx]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("brain-aix-eval");
  try {
    const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

    const decisions = await fetchAll<BrainDecisionRow & { matched: boolean | null; actual_aix_type: string | null }>((f, t) =>
      supabase.from("brain_decision_logs")
        .select("id, conversation_id, created_at, suggested_action, suggested_check_pattern, decision_source, scene_evidence, matched, actual_aix_type")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .range(f, t));
    const presses = await fetchAll<AixPressRow>((f, t) =>
      supabase.from("aix_usage_logs")
        .select("conversation_id, aix_type, check_pattern, created_at")
        .gte("created_at", sinceIso)
        .not("aix_type", "is", null)
        .order("created_at", { ascending: true })
        .range(f, t));

    // 1) 対にして書き戻す（判定が変わった行だけ）
    const pairs = pairBrainDecisions(decisions, presses);
    const prevById = new Map(decisions.map((d) => [d.id, d]));
    const toUpdate = pairs.filter((p) => {
      if (p.pending) return false;
      const prev = prevById.get(p.decision.id);
      return prev?.matched !== p.matched || (prev?.actual_aix_type ?? null) !== (p.press?.aix_type ?? null);
    });
    let updated = 0;
    await withConcurrency(toUpdate, 8, async (p) => {
      const { error } = await supabase.from("brain_decision_logs").update({
        actual_aix_type: p.press?.aix_type ?? null,
        actual_check_pattern: p.press?.check_pattern ?? null,
        actual_at: p.press?.created_at ?? null,
        matched: p.matched,
      }).eq("id", p.decision.id);
      if (!error) updated++;
    });

    // 2) scene_staff: スタッフが押す直前の顧客発言に場面の証拠を当て、場面ごとに押された AIX を数える
    const collapsed = collapsePresses(presses);
    const convIds = [...new Set(collapsed.map((p) => p.conversation_id))];
    const msgSince = new Date(Date.now() - (WINDOW_DAYS + 3) * 86_400_000).toISOString();
    type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
    const msgsByConv = new Map<string, Msg[]>();
    for (let i = 0; i < convIds.length; i += 25) {
      const chunk = convIds.slice(i, i + 25);
      const rows = await fetchAll<Msg>((f, t) =>
        supabase.from("messages")
          .select("conversation_id, sender, text, created_at")
          .in("conversation_id", chunk)
          .gte("created_at", msgSince)
          .order("created_at", { ascending: true })
          .range(f, t), 10000);
      for (const m of rows) {
        const arr = msgsByConv.get(m.conversation_id) ?? [];
        arr.push(m);
        msgsByConv.set(m.conversation_id, arr);
      }
    }
    const scenePresses: ScenePress[] = [];
    for (const p of collapsed) {
      const msgs = msgsByConv.get(p.conversation_id) ?? [];
      const pressAt = new Date(p.created_at).getTime();
      const before = msgs.filter((m) => new Date(m.created_at).getTime() < pressAt);
      const newestFirst = [...before].reverse();
      const turn = customerTurnBeforePress(newestFirst, pressAt);
      if (!turn.text && !turn.hasImage) continue;
      const prior = collapsed.filter((x) => x.conversation_id === p.conversation_id && new Date(x.created_at).getTime() < pressAt);
      const sentPropertyCount = prior.filter((x) => x.aix_type === "property_send" || x.aix_type === "property_recommendation").length;
      const ev = sceneEvidenceForTurn(turn, {
        sentPropertyCount,
        aixHistory: prior.map((x) => ({ aix_type: x.aix_type, check_pattern: x.check_pattern ?? null })),
        recentMessages: before.slice(-15).map((m) => ({ sender: m.sender, text: m.text })),
      });
      if (!ev || !p.aix_type) continue;
      scenePresses.push({ scene: ev.scene, candidateAction: ev.candidateAction, aix: normalizeAixForMatch(p.aix_type) });
    }

    // 3) 集計を upsert
    const rows = aggregateBrainAixFeedback(pairs, scenePresses, WINDOW_DAYS);
    if (rows.length > 0) {
      const now = new Date().toISOString();
      const { error } = await supabase.from("brain_aix_feedback").upsert(rows.map((r) => ({ ...r, updated_at: now })), { onConflict: "key" });
      if (error) throw new Error(`brain_aix_feedback upsert failed: ${error.message}`);
    }

    const judged = pairs.filter((p) => !p.pending);
    const withAction = judged.filter((p) => normalizeAixForMatch(p.decision.suggested_action));
    const result = {
      decisions: decisions.length,
      presses: presses.length,
      judged: judged.length,
      matched: judged.filter((p) => p.matched).length,
      with_action: withAction.length,
      with_action_matched: withAction.filter((p) => p.matched).length,
      updated,
      scene_presses: scenePresses.length,
      feedback_rows: rows.length,
    };
    console.log(JSON.stringify({ tag: "cron:brain-aix-eval", ...result }));
    await finishCronLog(runLogId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[brain-aix-eval] failed:", msg);
    await finishCronLog(runLogId, false, { error: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
