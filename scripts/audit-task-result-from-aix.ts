// scripts/audit-task-result-from-aix.ts — TASK_RESULT_FROM_AIX を on にする前の全件監査（読むだけ・LLM なし・費用 0）
//   2026-11-15 作業員H（統括役の頼み・竹内さん 11/15「送った事や確認した事を把握する部分も強化」）。
//   過去の「AIX 送信で済んだ物件確認のタスク」（line_tasks・結果なし）ごとに、その会話で済んだ時刻の前後10分の AIX【物件確認した】（aix_usage_logs）を探し、
//   taskResultFromAix が付ける結果と、実際に送った AIX の文（generated_text）の言葉が食い違わないかを数える（誤り0なら on）。
//   文は手元で読むだけ（画面に出すのは種類と数・例は id だけ）。使い方: npx tsx --env-file=<.env.local> scripts/audit-task-result-from-aix.ts [--days=60]
import { createClient } from "@supabase/supabase-js";
import { taskResultFromAix, resultOfAixText } from "../app/lib/task-result-from-aix";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const days = Number(arg("days") ?? "60");

if (process.argv[1] && /audit-task-result-from-aix\.ts$/.test(process.argv[1])) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: tasks } = await sb.from("line_tasks").select("id, conversation_id, task_type, status, completed_at, result").eq("task_type", "property_check").neq("status", "pending").gte("completed_at", since).limit(2000);
  const ts = ((tasks ?? []) as Array<{ id: string; conversation_id: string; completed_at: string | null; result: string | null }>).filter((t) => t.completed_at && !t.result);
  const tally = { tasks: ts.length, noAix: 0, notAttached: 0, attached: 0, agree: 0, textUnknown: 0, textMixed: 0, disagree: 0 };
  const byResult: Record<string, number> = {};
  const bad: string[] = [];
  for (const t of ts) {
    const at = Date.parse(t.completed_at!);
    const { data: logs } = await sb.from("aix_usage_logs").select("id, aix_type, check_pattern, prop_statuses, property_names, generated_text, created_at").eq("conversation_id", t.conversation_id)
      .eq("aix_type", "property_check_result").gte("created_at", new Date(at - 10 * 60_000).toISOString()).lte("created_at", new Date(at + 10 * 60_000).toISOString()).order("created_at", { ascending: false }).limit(1);
    const l = ((logs ?? []) as Array<{ id: string; aix_type: string; check_pattern: string | null; prop_statuses: string[] | null; property_names: string[] | null; generated_text: string | null }>)[0];
    if (!l) { tally.noAix++; continue; }
    const r = taskResultFromAix({ aixType: l.aix_type, checkPattern: l.check_pattern, propStatuses: l.prop_statuses, propertyNames: l.property_names, text: process.argv.includes("--no-text") ? null : l.generated_text });
    if (!r) { tally.notAttached++; continue; }
    tally.attached++; byResult[r.result] = (byResult[r.result] ?? 0) + 1;
    const tr = resultOfAixText(l.generated_text ?? "");
    // --read: 文から読めない・2つ読めた番を目で読む（数字は伏せる・手元だけ）
    if ((tr === null || tr === "mixed") && process.argv.includes("--read")) console.log(`[${tr ?? "読めない"}] 付ける=${r.result} cp=${l.check_pattern} st=${(l.prop_statuses ?? []).join(",")}｜${String(l.generated_text ?? "").replace(/[0-9０-９]{2,}/g, "#").replace(/\s+/g, " ").slice(0, 160)}`);
    if (tr === null) tally.textUnknown++;
    else if (tr === "mixed") tally.textMixed++;
    else if (tr === r.result || (r.result === "taken" && [l.check_pattern, ...(l.prop_statuses ?? [])].includes("alternative"))) tally.agree++;
    else { tally.disagree++; if (bad.length < 20) bad.push(`task ${t.id.slice(0, 8)} aix ${l.id.slice(0, 8)} 付ける=${r.result} 文=${tr} cp=${l.check_pattern} st=${(l.prop_statuses ?? []).join(",")}`); }
  }
  console.log(JSON.stringify({ days, ...tally, byResult }, null, 1));
  for (const b of bad) console.log(b);
})();
