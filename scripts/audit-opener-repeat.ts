// scripts/audit-opener-repeat.ts — 2026-10-06 ⑫（ゆいと「かしこまりました が並んでいる」）: opener-repeat.collapseRepeatedOpener の線（読むだけ・LLM なし）
//   ①人の手打ち（365日・AIX を除く）で変わる文の数（0 なら出口に入れてよい） ②本番の AI の下書き（ai_reply_examples・365日）で開口語の行が続いた数と例
// 実行: npx tsx --env-file=.env.local scripts/audit-opener-repeat.ts
import { createClient } from "@supabase/supabase-js";
import { collapseRepeatedOpener } from "../app/lib/opener-repeat";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
  let n = 0, h = 0; const hx: string[] = [];
  for (let f = 0; f < 60_000; f += 1000) {
    const { data } = await sb.from("messages").select("text").neq("sender", "customer").or("is_aix_generated.is.null,is_aix_generated.eq.false").gte("created_at", since).range(f, f + 999);
    for (const m of data ?? []) { n++; const r = collapseRepeatedOpener(String(m.text ?? "")); if (r.collapsed) { h++; if (hx.length < 5) hx.push(String(m.text).replace(/\n/g, " / ").slice(0, 80)); } }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`① 人の手打ち ${n}: 変わる ${h}`); for (const x of hx) console.log("   ", x);
  let dn = 0, dh = 0; const dx: string[] = [];
  for (let f = 0; f < 20_000; f += 1000) {
    const { data } = await sb.from("ai_reply_examples").select("ai_draft, created_at").gte("created_at", since).not("ai_draft", "is", null).range(f, f + 999);
    for (const r of data ?? []) { dn++; if (collapseRepeatedOpener(String(r.ai_draft)).collapsed) { dh++; if (dx.length < 8) dx.push(`${String(r.created_at).slice(0, 10)} ${String(r.ai_draft).replace(/\n/g, " / ").slice(0, 70)}`); } }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`② AI の下書き ${dn}: 開口語の行が続いた ${dh}`); for (const x of dx) console.log("   ", x);
})();
