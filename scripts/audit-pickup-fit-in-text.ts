// scripts/audit-pickup-fit-in-text.ts — 選んだ理由の札の合う点が、送った物件の AIX の文に入ったか（台帳 #793・読むだけ・LLM なし・DB は --write の時だけ書く）
// 2026-11-26 作業員A: 物件出しの AIX（ピックアップした・オススメ・申込以降を外す）で、送った時刻の前3日にツールで選んだ行の札の合う点のうち、
//   竹内さん本人の言い方の網（app/lib/pickup-fit-phrase）で文に入った割合。本文は出さない（数と札の名前だけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-fit-in-text.ts [--days=60] [--write]
import { createClient } from "@supabase/supabase-js";
import { fitInText, FIT_CODES } from "../app/lib/pickup-fit-phrase";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - Number(arg("days", "60")) * 864e5).toISOString();
  const { data: logs } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, generated_text").in("aix_type", ["property_send", "property_recommendation"]).gte("sent_at", since).not("generated_text", "is", null).limit(3000);
  const ls = ((logs ?? []) as Array<{ conversation_id: string; aix_type: string; sent_at: string; generated_text: string }>).filter((l) => !isTestConversation(l.conversation_id));
  const convs = [...new Set(ls.map((l) => l.conversation_id))];
  const pk: Array<{ conversation_id: string; created_at: string; reason_codes: string[] | null }> = [];
  for (let i = 0; i < convs.length; i += 100) {
    const { data } = await sb.from("property_pickups").select("conversation_id, created_at, reason_codes").in("conversation_id", convs.slice(i, i + 100)).gte("created_at", new Date(Date.parse(since) - 3 * 864e5).toISOString()).limit(20000);
    pk.push(...((data ?? []) as typeof pk));
  }
  let n = 0, fitN = 0, hitN = 0, anyHit = 0; const byCode: Record<string, { fit: number; hit: number }> = {}; const byType: Record<string, { n: number; fit: number; hit: number }> = {};
  for (const l of ls) {
    const t = Date.parse(l.sent_at);
    const codes = pk.filter((p) => p.conversation_id === l.conversation_id && Date.parse(p.created_at) <= t + 600_000 && t - Date.parse(p.created_at) <= 3 * 864e5).flatMap((p) => p.reason_codes ?? []);
    const r = fitInText(codes, l.generated_text);
    if (!r.fit.length) continue;
    n++; fitN += r.fit.length; hitN += r.hit.length; if (r.hit.length) anyHit++;
    { const o = (byType[l.aix_type] ??= { n: 0, fit: 0, hit: 0 }); o.n++; o.fit += r.fit.length; o.hit += r.hit.length; }
    for (const c of r.fit) { const o = (byCode[c] ??= { fit: 0, hit: 0 }); o.fit++; if (r.hit.includes(c)) o.hit++; }
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  console.log(`■ 札の合う点が文に入ったか（${arg("days", "60")}日・札のある物件出しの AIX ${n}通）: 合う点 ${hitN}/${fitN}（${pct(hitN, fitN) ?? "—"}%）・1つでも入った通 ${anyHit}/${n}（${pct(anyHit, n) ?? "—"}%）`);
  for (const [k, o] of Object.entries(byType)) console.log(`  種類 ${k}: ${o.n}通・合う点 ${o.hit}/${o.fit}（${pct(o.hit, o.fit)}%）`);
  for (const c of FIT_CODES) { const o = byCode[c]; if (o) console.log(`  ${c}: ${o.hit}/${o.fit}（${pct(o.hit, o.fit)}%）`); }
  if (process.argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const { error } = await sb.from("quality_daily").upsert([{ day, metric: "pickup:link:fit_in_text", scope: "all", value: pct(hitN, fitN), n: fitN, detail: { msgs: n, any_hit: anyHit, by_code: byCode, by_type: byType }, source: "scripts/audit-pickup-fit-in-text.ts（作業員A・#793）" }], { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log("書いた: quality_daily 1行");
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
