// scripts/audit-apply-docs-guard.ts
// 2026-10-02 竹内さん「申込み時に必要なのはフォーマットと本人確認書類の裏表写真」: apply-docs-guard.findExtraApplyDocs の線引き。読むだけ・LLM なし。
//   ①スタッフの手打ち（365日）で当たる文を目で読む（当たる＝スタッフも第三者の指示なしで書いた文。手本から外れる数）
//   ②AI の下書き（ai_reply_examples.ai_draft）で当たる文と、スタッフがその書類を送った文に残したか
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-docs-guard.ts [--days=365] [--show=30]
import { createClient } from "@supabase/supabase-js";
import { findExtraApplyDocs, EXTRA_APPLY_DOC_RE } from "../app/lib/apply-docs-guard";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365")), SHOW = Number(arg("show", "30"));
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  let n = 0, hit = 0, words = 0; const shown: string[] = [];
  for (let f = 0; f < 200_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("text, created_at, is_aix_generated").neq("sender", "customer").gte("created_at", since).order("created_at").range(f, f + 999);
    if (error) throw new Error(error.message);
    for (const m of data ?? []) {
      n++;
      const t = String(m.text ?? "");
      if (EXTRA_APPLY_DOC_RE.test(t)) words++;
      const h = findExtraApplyDocs(t);
      if (!h) continue;
      hit++;
      if (shown.length < SHOW) shown.push(`${String(m.created_at).slice(0, 10)} ${m.is_aix_generated ? "AIX" : "手"} [${h.word}] ${t.replace(/\n/g, " / ").slice(0, 150)}`);
    }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`① スタッフの送信 ${n}: 書類の語あり ${words}・当たる（第三者の指示の形でない）${hit}`);
  for (const s of shown) console.log("  ", s);
  const { data: ex } = await sb.from("ai_reply_examples").select("ai_draft, sent_reply").gte("created_at", since).not("ai_draft", "is", null).limit(1000);
  let dn = 0, dh = 0, kept = 0;
  for (const r of ex ?? []) {
    dn++;
    const h = findExtraApplyDocs(String(r.ai_draft ?? ""));
    if (!h) continue;
    dh++;
    const k = String(r.sent_reply ?? "").includes(h.word); if (k) kept++;
    console.log(`  下書き ${k ? "残" : "消"} [${h.word}] ${String(r.ai_draft).replace(/\n/g, " / ").slice(0, 120)}\n        送: ${String(r.sent_reply ?? "").replace(/\n/g, " / ").slice(0, 120)}`);
  }
  console.log(`② AI の下書き ${dn}: 当たる ${dh}（スタッフが送った文にその書類が残った ${kept}）`);
})();
