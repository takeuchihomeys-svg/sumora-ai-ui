// app/lib/pickup-complete-server.ts（サーバー専用・DB・DeepSeek。画面側から import しない）
// 拡張でお客様の作業を終えた時（「確認」☑／「✅ 送った」）に、そのお客様の売上サポのピックアップを1つのまとめにする。
//   ① claimCompleteGroup（速い・応答の前）: 対象の行を選び、まとめ ID を付ける（complete_group_id が空の行だけ＝冪等）
//   ② finishCompleteGroup（重い・waitUntil）: まだ読んでいない物件を自動の読み取り（pickup-auto-analyze・DeepSeek だけ・保存済み／外す候補は読まない）→
//      まとめた全件で順位（complete_rank）と 👑（property_pickup_completions.best_id）を付け直す
// 決まりの本体は pickup-complete.ts（純関数）。
//
// 2026-09-25 竹内「スタッフモードで送った時は、拡張ツールはお客さんのところ完了ボタン押したら、リアプロと itandi の全部分析されるようにする」
//   🧠×スタッフ は必ず・🧠×通常／🧠×AIX も「完了」を押した時はまとめる（自動送信の回も一緒に）。ブレイン OFF は売上サポに届いていないので何もしない
//
// 2026-09-25 竹内「最後にスタッフモードで指定したお客さん…10分たてば自動的に送られた物件まとめて…まとめて判定する」:
//   10分の自動まとめ。どれか1つが動けばまとまる3つの入口（全部 claimCompleteGroup の quietMs 付き＝同じまとめ ID・行の取り合いで冪等）:
//     ① Vercel Cron /api/cron/pickup-auto-complete（2分おき・runAutoCompleteSweep）… 本体。PC が消えていても動く
//     ② 拡張 background.js の chrome.alarms（merge-pdfs の送信から10分半後に /complete {idle:true}）… PC が付いている間
//     ③ 売上サポの詳細を開いた時（/api/property-pickups?view=detail）… 開いた時に10分を過ぎていればその場でまとめる
//   止まった時: まとめ ID を付けた後に読み取り・順位が途中で切れた（関数の打ち切り等）まとめは status=running のまま残る
//     → Cron が 15分を過ぎた running を1回だけ retry に変えて（条件付き UPDATE で取る）finishCompleteGroup をやり直す（保存済みの分析は読まない）
import { supabase } from "@/app/lib/supabase";
import { selectCompleteTargets, completeGroupId, rankCompleteGroup, autoCompleteDue, isQuietFor, lastOpenAt, COMPLETE_WINDOW_HOURS, AUTO_COMPLETE_QUIET_MS, type CompleteSourceRow, type CompleteRankRow, type CompleteRanking, type AutoCompleteRow } from "@/app/lib/pickup-complete";
import { bestBasisFor, customerImageNeed, type BestBasis } from "@/app/lib/pickup-best";

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
  /** quietMs を付けて呼んだ時、まだ最後の行から quietMs 経っていない（まとめない）。dueAt＝まとめてよくなる時刻 */
  notDue: boolean;
  dueAt: string | null;
  error: string | null;
};

type CompleteMeta = { trigger: string | null; mode: string | null; requestedBy: string | null };

/**
 * ① 対象の行にまとめ ID を付ける（冪等）。失敗しても投げない。
 * opts.quietMs（10分の自動まとめ）: まだまとめていない一番新しい行から quietMs 経っていなければ何もしない（notDue・dueAt）
 */
export async function claimCompleteGroup(propertyCustomerId: string, meta: CompleteMeta, now = Date.now(), opts?: { quietMs?: number }): Promise<ClaimResult> {
  const out: ClaimResult = { ok: false, groupId: null, claimedIds: [], sites: {}, batchIds: [], already: false, conversationId: null, notDue: false, dueAt: null, error: null };
  try {
    const since = new Date(now - COMPLETE_WINDOW_HOURS * 3600_000).toISOString();
    const { data, error } = await supabase.from("property_pickups")
      .select("id, created_at, batch_id, site, status, complete_group_id, conversation_id")
      .eq("property_customer_id", propertyCustomerId).gte("created_at", since)
      .order("created_at", { ascending: true }).limit(500);
    if (error) { out.error = error.message; return out; }
    const rows = (data ?? []) as Array<CompleteSourceRow & { conversation_id: string | null }>;
    out.conversationId = [...rows].reverse().find((r) => r.conversation_id)?.conversation_id ?? null;
    if (opts?.quietMs != null) {
      const last = lastOpenAt(rows);
      if (last != null && !isQuietFor(last, now, opts.quietMs)) {
        out.ok = true; out.notDue = true; out.dueAt = new Date(last + opts.quietMs).toISOString();
        return out;
      }
    }
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
    // 10分の自動まとめは詳細を開くたびに呼ぶので、何もしなかった時（まだ・まとめる物なし）は記録しない
    if (!(meta.trigger === "idle" && !out.claimedIds.length && !out.error)) {
      console.log(JSON.stringify({ tag: "property-pickups:complete-claim", customer: propertyCustomerId.slice(0, 8), group: out.groupId, claimed: out.claimedIds.length, sites: out.sites, already: out.already, trigger: meta.trigger, mode: meta.mode, by: meta.requestedBy, error: out.error }));
    }
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
    // 👑 の決め方はお客様ごと（画像で分析が必要＝画像の点・不要＝判定の点）。画面の詳細 API と同じ customerImageNeed → bestBasisFor
    const basis = await loadBestBasis(input.propertyCustomerId, rows);
    const ranking = rankCompleteGroup(rows, { basis });
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
      result: { basis_rule: basis, items: ranking.items, batches: ranking.batches, image_scored: ranking.imageScored, not_analyzed: ranking.notAnalyzed, best_match: ranking.bestMatch, best_score: ranking.bestScore, analyzed_now: out.analyzed, analyze_level: out.analyzeLevel, analyze_targets: out.analyzeTargets },
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

/** お客様の 👑 の決め方（画面の詳細 API と同じ: 分析済みの希望 or 条件欄 → imageAnalysisNeed → recommended なら image）。読めなければ image */
// 反証（2026-09-25）: 保存した希望（wants）は、画面の詳細 API と同じ行の集まり（そのお客様の新しい順 300行の中で一番新しい分析）から取る。
//   まとめの行だけから取ると、まとめの中に分析済みの行が無い（または古い分析しか無い）時に画面は「分析の希望」・まとめは「条件欄だけ」で
//   決まりが割れ、best_id と画面の 👑 が別の物件になる。読めない時だけ渡された rows に戻す
export async function loadBestBasis(propertyCustomerId: string, rows: ReadonlyArray<{ image_analysis?: { wants?: unknown; [k: string]: unknown } | null }>): Promise<BestBasis> {
  try {
    const [{ data }, recent] = await Promise.all([
      supabase.from("property_customers").select("preferences, ng_points, other_requests, additional_conditions").eq("id", propertyCustomerId).maybeSingle(),
      supabase.from("property_pickups").select("id, wants:image_analysis->wants").eq("property_customer_id", propertyCustomerId)
        .order("created_at", { ascending: false }).limit(300),
    ]);
    const recentRows = recent.error ? null : ((recent.data ?? []) as Array<{ wants?: unknown }>).map((r) => ({ image_analysis: { wants: r.wants } }));
    return bestBasisFor(customerImageNeed(recentRows ?? rows, (data ?? null) as Parameters<typeof customerImageNeed>[1]));
  } catch {
    return "image";
  }
}

/**
 * 10分の自動まとめを1人分（拡張の alarm・詳細を開いた時）。まとめたら重い処理は返す job で（呼ぶ側が waitUntil）。
 * 失敗しても投げない
 */
export async function claimIdleComplete(propertyCustomerId: string, requestedBy: string, now = Date.now()): Promise<{ claim: ClaimResult; job: Promise<FinishResult> | null }> {
  const claim = await claimCompleteGroup(propertyCustomerId, { trigger: "idle", mode: null, requestedBy }, now, { quietMs: AUTO_COMPLETE_QUIET_MS });
  const job = claim.ok && claim.groupId && claim.claimedIds.length
    ? finishCompleteGroup({ groupId: claim.groupId, claimedIds: claim.claimedIds, propertyCustomerId, conversationId: claim.conversationId, deadlineAt: Date.now() + 200_000 })
    : null;
  return { claim, job };
}

export type SweepReport = {
  ok: boolean;
  due: number;
  waiting: number;
  claimed: Array<{ customer: string; group: string | null; items: number; best: number | null; basis: string | null; error: string | null }>;
  retried: Array<{ group: string; best: number | null; error: string | null }>;
  error: string | null;
  ms: number;
};

/** 1回の Cron でまとめるお客様の数（1人 最大20件・同時3件の読み取り。関数の 300秒に収める）。残りは次の回（2分後） */
const SWEEP_MAX_CUSTOMERS = 3;
/** running のまま止まったとみなす時間（finish は最長 約300秒） */
const STUCK_AFTER_MS = 15 * 60_000;

/** Cron の本体: 10分静かなお客様をまとめる＋止まったまとめをやり直す。dry は選ぶだけ（書かない） */
export async function runAutoCompleteSweep(opts: { now?: number; dry?: boolean; deadlineAt?: number; onlyCustomer?: string | null } = {}): Promise<SweepReport> {
  const t0 = Date.now();
  const now = opts.now ?? Date.now();
  const out: SweepReport = { ok: false, due: 0, waiting: 0, claimed: [], retried: [], error: null, ms: 0 };
  try {
    const since = new Date(now - COMPLETE_WINDOW_HOURS * 3600_000).toISOString();
    let q = supabase.from("property_pickups").select("id, created_at, property_customer_id, complete_group_id")
      .is("complete_group_id", null).not("property_customer_id", "is", null).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(3000);
    if (opts.onlyCustomer) q = q.eq("property_customer_id", opts.onlyCustomer);
    const { data, error } = await q;
    if (error) { out.error = error.message; return out; }
    const sel = autoCompleteDue((data ?? []) as AutoCompleteRow[], now);
    out.due = sel.due.length; out.waiting = sel.waiting.length;
    if (opts.dry) {
      out.claimed = sel.due.map((d) => ({ customer: d.property_customer_id.slice(0, 8), group: null, items: d.open, best: null, basis: null, error: null }));
      out.ok = true;
      return out;
    }
    const deadlineAt = opts.deadlineAt ?? Date.now() + 200_000;
    const jobs: Array<Promise<void>> = [];
    for (const d of sel.due.slice(0, SWEEP_MAX_CUSTOMERS)) {
      const claim = await claimCompleteGroup(d.property_customer_id, { trigger: "idle", mode: null, requestedBy: "cron" }, now, { quietMs: AUTO_COMPLETE_QUIET_MS });
      const rec = { customer: d.property_customer_id.slice(0, 8), group: claim.groupId, items: claim.claimedIds.length, best: null as number | null, basis: null as string | null, error: claim.error };
      out.claimed.push(rec);
      if (claim.ok && claim.groupId && claim.claimedIds.length) {
        jobs.push(finishCompleteGroup({ groupId: claim.groupId, claimedIds: claim.claimedIds, propertyCustomerId: d.property_customer_id, conversationId: claim.conversationId, deadlineAt })
          .then((f) => { rec.best = f.ranking?.bestId ?? null; rec.basis = f.ranking?.bestBasis ?? null; rec.error = f.error; }));
      }
    }
    // 止まったまとめ（running のまま 15分）を1回だけやり直す。running → retry の条件付き UPDATE で取る（Cron が重なっても1つだけ）
    if (!opts.onlyCustomer) {
      const stuckBefore = new Date(now - STUCK_AFTER_MS).toISOString();
      const { data: stuck } = await supabase.from("property_pickup_completions").select("group_id, property_customer_id, conversation_id")
        .eq("status", "running").lt("created_at", stuckBefore).gte("created_at", since).limit(2);
      for (const g of (stuck ?? []) as Array<{ group_id: string; property_customer_id: string | null; conversation_id: string | null }>) {
        if (!g.property_customer_id) continue;
        const { data: took } = await supabase.from("property_pickup_completions").update({ status: "retry" }).eq("group_id", g.group_id).eq("status", "running").select("group_id");
        if (!took?.length) continue;
        const { data: ids } = await supabase.from("property_pickups").select("id").eq("complete_group_id", g.group_id).limit(500);
        const rec = { group: g.group_id, best: null as number | null, error: null as string | null };
        out.retried.push(rec);
        jobs.push(finishCompleteGroup({ groupId: g.group_id, claimedIds: ((ids ?? []) as Array<{ id: number }>).map((r) => r.id), propertyCustomerId: g.property_customer_id, conversationId: g.conversation_id, deadlineAt })
          .then((f) => { rec.best = f.ranking?.bestId ?? null; rec.error = f.error; }));
      }
    }
    await Promise.allSettled(jobs);
    out.ok = true;
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  } finally {
    out.ms = Date.now() - t0;
    if (out.claimed.length || out.retried.length || out.error) {
      console.log(JSON.stringify({ tag: "property-pickups:auto-complete", dry: !!opts.dry, due: out.due, waiting: out.waiting, claimed: out.claimed, retried: out.retried, ms: out.ms, error: out.error }));
    }
  }
}
