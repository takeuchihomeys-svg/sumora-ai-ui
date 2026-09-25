// app/lib/pickup-complete-server.ts（サーバー専用・DB・DeepSeek。画面側から import しない）
// 拡張でお客様の作業を終えた時（「確認」☑／「✅ 送った」）に、そのお客様の売上サポのピックアップを1つのまとめにする。
//   ① claimCompleteGroup（速い・応答の前）: 対象の行を選び、まとめ ID を付ける（complete_group_id が空の行だけ＝冪等）
//   ② finishCompleteGroup（重い・waitUntil）: まだ読んでいない物件を自動の読み取り（pickup-auto-analyze・DeepSeek だけ・保存済み／外す候補は読まない）→
//      まとめた全件で順位（complete_rank）と 👑（property_pickup_completions.best_id）を付け直す
// 決まりの本体は pickup-complete.ts（純関数）。
//
// 2026-09-25 竹内「スタッフモードで送った時は、拡張ツールはお客さんのところ完了ボタン押したら、リアプロと itandi の全部分析されるようにする」
//   🧠×スタッフ は必ず・🧠×通常／🧠×AIX も「完了」を押した時はまとめる（自動送信の回も一緒に）。ブレイン OFF は売上サポに届いていないので何もしない
import { supabase } from "@/app/lib/supabase";
import { selectCompleteTargets, completeGroupId, rankCompleteGroup, COMPLETE_WINDOW_HOURS, type CompleteSourceRow, type CompleteRankRow, type CompleteRanking } from "@/app/lib/pickup-complete";

export type ClaimResult = {
  ok: boolean;
  groupId: string | null;
  /** この呼び出しでまとめに入れた行 */
  claimedIds: number[];
  sites: Record<string, number>;
  batchIds: string[];
  /** もう他の呼び出し（二重押し・別の PC）がまとめていた */
  already: boolean;
  conversationId: string | null;
  error: string | null;
};

type CompleteMeta = { trigger: string | null; mode: string | null; requestedBy: string | null };

/** ① 対象の行にまとめ ID を付ける（冪等）。失敗しても投げない */
export async function claimCompleteGroup(propertyCustomerId: string, meta: CompleteMeta, now = Date.now()): Promise<ClaimResult> {
  const out: ClaimResult = { ok: false, groupId: null, claimedIds: [], sites: {}, batchIds: [], already: false, conversationId: null, error: null };
  try {
    const since = new Date(now - COMPLETE_WINDOW_HOURS * 3600_000).toISOString();
    const { data, error } = await supabase.from("property_pickups")
      .select("id, created_at, batch_id, site, status, complete_group_id, conversation_id")
      .eq("property_customer_id", propertyCustomerId).gte("created_at", since)
      .order("created_at", { ascending: true }).limit(500);
    if (error) { out.error = error.message; return out; }
    const rows = (data ?? []) as Array<CompleteSourceRow & { conversation_id: string | null }>;
    out.conversationId = [...rows].reverse().find((r) => r.conversation_id)?.conversation_id ?? null;
    const t = selectCompleteTargets(rows, now);
    if (!t.ids.length) {
      out.ok = true; out.groupId = t.latestGroupId; out.already = t.alreadyGrouped > 0;
      return out;
    }
    const gid = completeGroupId(propertyCustomerId, t.ids);
    if (!gid) { out.error = "まとめ ID を作れない"; return out; }
    out.groupId = gid;
    // まとめの行（1まとめ1行・主キー＝まとめ ID）。同じ ID がもうあれば何もしない（2台目・二重押し）
    const { error: cErr } = await supabase.from("property_pickup_completions").upsert({
      group_id: gid, property_customer_id: propertyCustomerId, conversation_id: out.conversationId,
      trigger: meta.trigger, mode: meta.mode, requested_by: meta.requestedBy, status: "running",
    }, { onConflict: "group_id", ignoreDuplicates: true });
    if (cErr) console.warn("[pickup-complete] まとめの行を書けない（行へのまとめ ID は続ける）:", cErr.message);
    // 行に付ける: complete_group_id が空の行だけ（先に書いた呼び出しだけが行を取る＝後の呼び出しは 0件）
    const { data: claimed, error: uErr } = await supabase.from("property_pickups")
      .update({ complete_group_id: gid }).in("id", t.ids).is("complete_group_id", null).select("id, site, batch_id");
    if (uErr) { out.error = uErr.message; return out; }
    const got = (claimed ?? []) as Array<{ id: number; site: string | null; batch_id: string }>;
    out.claimedIds = got.map((r) => r.id).sort((a, z) => a - z);
    out.already = got.length === 0;
    const sel = selectCompleteTargets(rows.filter((r) => out.claimedIds.includes(r.id)), now);
    out.sites = sel.sites; out.batchIds = sel.batchIds;
    out.ok = true;
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  } finally {
    console.log(JSON.stringify({ tag: "property-pickups:complete-claim", customer: propertyCustomerId.slice(0, 8), group: out.groupId, claimed: out.claimedIds.length, sites: out.sites, already: out.already, trigger: meta.trigger, mode: meta.mode, error: out.error }));
  }
}

export type FinishResult = {
  groupId: string;
  analyzed: number;
  analyzeLevel: string | null;
  analyzeTargets: number;
  ranking: CompleteRanking | null;
  ms: number;
  error: string | null;
};

/**
 * ② 自動の読み取り → まとめた全件で順位と 👑。waitUntil の中で呼ぶ（応答は待たせない）。失敗しても投げない。
 * claimedIds＝この呼び出しで取った行だけ読む（2台目が取った行は2台目が読む＝同じ物件を二重に読まない）。順位は毎回まとめ全体で付け直す
 */
export async function finishCompleteGroup(input: { groupId: string; claimedIds: number[]; propertyCustomerId: string; conversationId: string | null; deadlineAt?: number }): Promise<FinishResult> {
  const t0 = Date.now();
  const out: FinishResult = { groupId: input.groupId, analyzed: 0, analyzeLevel: null, analyzeTargets: 0, ranking: null, ms: 0, error: null };
  try {
    if (input.claimedIds.length) {
      const { autoAnalyzeBatch } = await import("@/app/lib/pickup-auto-analyze");
      const a = await autoAnalyzeBatch({ ids: input.claimedIds, propertyCustomerId: input.propertyCustomerId, conversationId: input.conversationId, deadlineAt: input.deadlineAt });
      out.analyzed = a.analyzed; out.analyzeLevel = a.level; out.analyzeTargets = a.targets;
    }
    const { data, error } = await supabase.from("property_pickups")
      .select("id, created_at, batch_id, site, rank, status, recommended, property_name, room_no, verdict, score, image_analysis")
      .eq("complete_group_id", input.groupId).limit(500);
    if (error) { out.error = error.message; return out; }
    const rows = (data ?? []) as CompleteRankRow[];
    const ranking = rankCompleteGroup(rows);
    out.ranking = ranking;
    // 順位を行に（まとめ ID が同じ行だけ）
    await Promise.allSettled(ranking.order.map((o) => supabase.from("property_pickups").update({ complete_rank: o.complete_rank }).eq("id", o.id).eq("complete_group_id", input.groupId)));
    const sites: Record<string, number> = {};
    for (const r of rows) { const k = r.site ?? "unknown"; sites[k] = (sites[k] ?? 0) + 1; }
    const { error: cErr } = await supabase.from("property_pickup_completions").update({
      status: "done", finished_at: new Date().toISOString(),
      item_ids: rows.map((r) => r.id).sort((a, z) => a - z),
      batch_ids: [...new Set(rows.map((r) => r.batch_id))],
      sites,
      best_id: ranking.bestId, best_basis: ranking.bestBasis,
      result: { items: ranking.items, batches: ranking.batches, image_scored: ranking.imageScored, not_analyzed: ranking.notAnalyzed, best_match: ranking.bestMatch, best_score: ranking.bestScore, analyzed_now: out.analyzed, analyze_level: out.analyzeLevel, analyze_targets: out.analyzeTargets },
    }).eq("group_id", input.groupId);
    if (cErr) console.warn("[pickup-complete] まとめの結果を書けない:", cErr.message);
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    await supabase.from("property_pickup_completions").update({ status: "error", finished_at: new Date().toISOString(), result: { error: out.error } }).eq("group_id", input.groupId).then(() => undefined, () => undefined);
    return out;
  } finally {
    out.ms = Date.now() - t0;
    console.log(JSON.stringify({ tag: "property-pickups:complete-finish", group: input.groupId, claimed: input.claimedIds.length, analyzed: out.analyzed, level: out.analyzeLevel, best: out.ranking?.bestId ?? null, basis: out.ranking?.bestBasis ?? null, items: out.ranking?.items ?? 0, ms: out.ms, error: out.error }));
  }
}
