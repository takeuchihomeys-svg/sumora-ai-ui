// scripts/check-exam-situation-now.ts — 組み直した situation_now（scripts/lib/exam-situation-now.ts）が本番の記録と合うかを、欄の数で比べる（読むだけ・LLM なし）
//   2026-11-21 作業員K2: 本番の brain_decision_logs.digest.sn（situationNowDigest・11/18 から shadow）の番で、その記録の時刻で組み直して欄ごとの一致率を出す。
//   比べる欄（作業員L）: tw 時の言葉・tv 内覧の予定・se 送った事・ch 確認した事・oi 前に送った文の項目・ou そのうち答えが無い物・po 開いている約束。
// 実行: npx tsx --env-file=<鍵のある .env> scripts/check-exam-situation-now.ts [--n=80] [--since=2026-11-18]
import { createClient } from "@supabase/supabase-js";
import { situationNowDigest } from "../app/lib/situation-now";
import { isTestConversation } from "../app/lib/test-conversations";
import { rebuildSituationNowAt } from "./lib/exam-situation-now";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg("n", "80"));
const SINCE = arg("since", "2026-11-18T00:00:00Z");
const FIELDS = ["tw", "tv", "se", "ch", "oi", "ou", "po"] as const;

(async () => {
  const { data, error } = await sb.from("brain_decision_logs").select("conversation_id, created_at, digest").gte("created_at", SINCE).not("digest->sn", "is", null).order("created_at", { ascending: false }).limit(N * 3);
  if (error) throw new Error(error.message);
  const seen = new Set<string>();
  const rows = ((data ?? []) as Array<{ conversation_id: string; created_at: string; digest: { sn?: Record<string, number> } }>)
    .filter((r) => r.digest?.sn && !isTestConversation(r.conversation_id) && !seen.has(r.conversation_id) && seen.add(r.conversation_id)).slice(0, N);
  const same: Record<string, number> = {}, near: Record<string, number> = {}, diffs: Record<string, string[]> = {};
  for (const r of rows) {
    const sn = situationNowDigest(await rebuildSituationNowAt(sb, r.conversation_id, r.created_at)) ?? {};
    for (const f of FIELDS) {
      const a = Number(r.digest.sn?.[f] ?? 0), b = Number(sn[f] ?? 0);
      if (a === b) same[f] = (same[f] ?? 0) + 1;
      if (Math.abs(a - b) <= 1) near[f] = (near[f] ?? 0) + 1;
      else (diffs[f] ??= []).length < 4 && diffs[f].push(`${r.conversation_id.slice(0, 8)} 本番${a}→組み直し${b}`);
    }
  }
  console.log(`=== 本番の記録 ${rows.length}番（会話ごとに最新1つ・${SINCE} 以降）`);
  for (const f of FIELDS) console.log(`${f}: 一致 ${same[f] ?? 0}/${rows.length}（${Math.round(((same[f] ?? 0) / Math.max(1, rows.length)) * 100)}%）・±1 ${near[f] ?? 0}/${rows.length}${diffs[f]?.length ? `｜例 ${diffs[f].join("／")}` : ""}`);
})().catch((e) => { console.error(e); process.exit(1); });
