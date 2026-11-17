// scripts/audit-promise-close-sample.ts — 約束の結び付け（promise-close-link）を過去の行に当てて、結んだ組を目で確かめる見本を出す（読むだけ・LLM なし・費用0）
//
// 2026-11-15 作業員L（統括役「誤って結んだ物が0かを目で数件確かめる」）。会話の文は出さない（約束と済みの行の種類・時刻・要件の名前・evidence の頭だけ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-close-sample.ts [--days=14] [--n=12] [--how=same_object|unnamed]
import { createClient } from "@supabase/supabase-js";
import { linkPromiseClosures, PROMISE_OF_DONE, type FactForLink } from "../app/lib/promise-close-link";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - Number(arg("days", "14")) * 86_400_000).toISOString();
  const kinds = [...Object.keys(PROMISE_OF_DONE), ...Object.values(PROMISE_OF_DONE)];
  const { data, error } = await sb.from("sent_facts").select("id, conversation_id, kind, status, sent_at, aix_type, line_message_id, detail, evidence").in("kind", kinds).gte("sent_at", since).order("sent_at").limit(3000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<FactForLink & { conversation_id: string; evidence?: string | null }>;
  const byConv = new Map<string, typeof rows>();
  for (const r of rows) { const a = byConv.get(r.conversation_id) ?? []; a.push(r); byConv.set(r.conversation_id, a); }
  const want = arg("how", "");
  const n = Number(arg("n", "12"));
  let shown = 0;
  const name = (d: Record<string, unknown> | null | undefined) => [d?.object, ...((d?.propertyNames as string[] | undefined) ?? []), ...((d?.estimateFor as string[] | undefined) ?? [])].filter(Boolean).map((x) => String(x).slice(0, 14)).join("・") || "（名前なし）";
  for (const [conv, rs] of byConv) {
    const links = linkPromiseClosures(rs, rs.filter((x) => x.status === "done"));
    for (const l of links) {
      if (want && l.closedBy.how !== want) continue;
      const p = rs.find((x) => String(x.id) === String(l.promiseId))!;
      const d = rs.find((x) => x.sent_at === l.closedBy.sent_at && x.kind === l.closedBy.kind);
      const h = ((Date.parse(l.closedBy.sent_at) - Date.parse(p.sent_at)) / 3_600_000).toFixed(1);
      console.log(`${conv.slice(0, 6)} ${l.closedBy.how.padEnd(11)} 約束 ${p.kind}「${name(p.detail)}」(${String(p.evidence ?? "").slice(0, 16)}) → ${h}時間後 ${l.closedBy.kind}/${l.closedBy.aix_type ?? "返信"}「${name(d?.detail)}」`);
      if (++shown >= n) return;
    }
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
