// app/lib/ops-anomaly-server.ts — 本番の異常の知らせの数え（SQL の件数だけ）と記録（ops_anomalies・サーバーの鍵だけで書ける）
//   判断は app/lib/ops-anomaly.ts の純関数。ここは数えて書くだけ
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { evaluateAnomalies, planAnomalyWrites, anomalyDestinations, anomalyLineTargetFrom, anomalyLineConversation, shouldLineNotify, anomalyLineText, LINE_NOTIFY_MIN_INTERVAL_MS, ANOMALY_LABEL, type Anomaly, type AnomalyStats } from "./ops-anomaly";

export function opsAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
}

/** 失敗の行（5xx か 0）を窓で数える。失敗は1週で十数件と少ない＝行を読んで JS で除く（alt_skipped_pii・テスト・script:） */
async function llmFailIn(db: SupabaseClient, from: Date, to: Date): Promise<number> {
  const { data, error } = await db.from("llm_usage_logs").select("error_type, env, route")
    .gte("created_at", from.toISOString()).lt("created_at", to.toISOString()).or("status.gte.500,status.eq.0").limit(1000);
  if (error) throw new Error(`llm_usage_logs: ${error.message}`);
  return (data ?? []).filter((r) => r.error_type !== "alt_skipped_pii" && !String(r.env ?? "").includes("test") && !String(r.route ?? "").startsWith("script:")).length;
}
const cnt = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>, what: string): Promise<number> => {
  const r = await q; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.count ?? 0;
};

export async function collectAnomalyStats(db: SupabaseClient, now = new Date()): Promise<AnomalyStats> {
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const week = 7 * 24 * 60;
  // 型の組を崩さないよう、過去4週の同じ15分は別の Promise.all に分ける（11/03 tsc-remote で見つかった型エラー）
  const [llmFail15, baseline, draftStuck, cronRows, customerMsgs90, brainLogs90] = await Promise.all([
    llmFailIn(db, ago(15), now),
    Promise.all([1, 2, 3, 4].map((w) => llmFailIn(db, ago(w * week + 15), ago(w * week)))),
    cnt(db.from("conversations").select("id", { count: "exact", head: true }).gte("draft_pending_at", ago(360).toISOString()).lt("draft_pending_at", ago(15).toISOString()), "conversations"),
    db.from("cron_run_logs").select("cron_name").eq("ok", false).gte("started_at", ago(30).toISOString()).limit(500).then((r): Array<{ cron_name: string }> => { if (r.error) throw new Error(`cron_run_logs: ${r.error.message}`); return (r.data ?? []) as Array<{ cron_name: string }>; }),
    cnt(db.from("messages").select("id", { count: "exact", head: true }).eq("sender", "customer").gte("created_at", ago(90).toISOString()), "messages"),
    cnt(db.from("brain_decision_logs").select("id", { count: "exact", head: true }).gte("created_at", ago(90).toISOString()), "brain_decision_logs"),
  ]);
  const byCron = new Map<string, number>();
  for (const r of cronRows as Array<{ cron_name: string }>) byCron.set(r.cron_name, (byCron.get(r.cron_name) ?? 0) + 1);
  return {
    llmFail15, llmFailBaseline: baseline, draftStuck,
    cronFail30: cronRows.length, cronFailNames: [...byCron].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}×${c}`),
    customerMsgs90, brainLogs90, jstHour: new Date(now.getTime() + 9 * 3600_000).getUTCHours(),
  };
}

/** 数えて・決めて・書く。dry は書かない */
export async function runOpsAnomalyWatch(db: SupabaseClient, o: { dry?: boolean; now?: Date } = {}): Promise<{ stats: AnomalyStats; anomalies: Anomaly[]; inserted: number; updated: number; resolved: number }> {
  const now = o.now ?? new Date();
  const stats = await collectAnomalyStats(db, now);
  const anomalies = evaluateAnomalies(stats);
  if (o.dry) return { stats, anomalies, inserted: 0, updated: 0, resolved: 0 };
  // 見張りの種類の行だけ（rollout_down 等の別の知らせは、ここでは閉じない）
  const { data: open, error } = await db.from("ops_anomalies").select("id, kind, severity, value").is("resolved_at", null).in("kind", Object.keys(ANOMALY_LABEL));
  if (error) throw new Error(`ops_anomalies: ${error.message}`);
  const plan = planAnomalyWrites((open ?? []) as Array<{ id: string; kind: string; severity: string; value: number }>, anomalies);
  const iso = now.toISOString();
  const dests = anomalyDestinations();
  if (plan.insert.length) {
    // 竹内さん個人の LINE（新しく開いた種類だけ・同じ種類は1時間に1回まで・宛先の env が無ければ送らない）
    const lineConv = anomalyLineConversation();
    const target = lineConv ? anomalyLineTargetFrom(((await db.from("conversations").select("line_user_id, account").eq("id", lineConv).maybeSingle()).data ?? null) as { line_user_id?: string | null; account?: string | null } | null) : null;
    const lineOk = new Set<string>();
    if (target) {
      const { data: recent } = await db.from("ops_anomalies").select("kind, first_seen_at").contains("notified", ["line"]).gte("first_seen_at", new Date(now.getTime() - LINE_NOTIFY_MIN_INTERVAL_MS).toISOString());
      const lastBy: Record<string, string> = {};
      for (const r of (recent ?? []) as Array<{ kind: string; first_seen_at: string }>) if (!lastBy[r.kind] || r.first_seen_at > lastBy[r.kind]) lastBy[r.kind] = r.first_seen_at;
      for (const a of plan.insert) {
        if (!shouldLineNotify(a.kind, lastBy, now.getTime(), dests)) continue;
        try {
          const res = await fetch("https://api.line.me/v2/bot/message/push", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.token}` }, body: JSON.stringify({ to: target.to, messages: [{ type: "text", text: anomalyLineText(a) }] }), signal: AbortSignal.timeout(10_000) });
          if (res.ok) lineOk.add(a.kind); else console.warn("[ops-anomaly] LINE に送れない:", res.status);
        } catch (e) { console.warn("[ops-anomaly] LINE に送れない:", e instanceof Error ? e.message : e); }
      }
    }
    const { error: e } = await db.from("ops_anomalies").insert(plan.insert.map((a) => ({ kind: a.kind, label: ANOMALY_LABEL[a.kind], severity: a.severity, value: a.value, baseline: a.baseline, why: a.why, detail: a.detail ?? null, first_seen_at: iso, last_seen_at: iso, notified: [...dests.filter((d) => d === "table"), ...(lineOk.has(a.kind) ? ["line"] : [])] })));
    if (e) throw new Error(`ops_anomalies insert: ${e.message}`);
  }
  for (const u of plan.update) {
    // 回数は読んで足さない（同時の書き込みは無い・5分に1回）＝ value・why・last_seen を今の値に
    await db.from("ops_anomalies").update({ severity: u.a.severity, value: u.a.value, baseline: u.a.baseline, why: u.a.why, detail: u.a.detail ?? null, last_seen_at: iso }).eq("id", u.id);
  }
  if (plan.resolve.length) await db.from("ops_anomalies").update({ resolved_at: iso }).in("id", plan.resolve);
  return { stats, anomalies, inserted: plan.insert.length, updated: plan.update.length, resolved: plan.resolve.length };
}

/** 画面の上の印に出す開いた行（個人情報は持たない: 種類・件数・時刻だけ） */
export async function openAnomalies(db: SupabaseClient): Promise<Array<{ kind: string; label: string; severity: string; why: string; first_seen_at: string; last_seen_at: string }>> {
  const { data, error } = await db.from("ops_anomalies").select("kind, label, severity, why, first_seen_at, last_seen_at").is("resolved_at", null).order("first_seen_at", { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ kind: string; label: string; severity: string; why: string; first_seen_at: string; last_seen_at: string }>;
}
