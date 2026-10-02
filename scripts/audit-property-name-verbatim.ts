// scripts/audit-property-name-verbatim.ts
// 2026-10-02 ⑫: 出口 enforceVerbatimPropertyNames（化けた物件名を会話・資料の字に直す）を、本番のスタッフの送信（手打ち・AIX）に当てて
//   直してしまう通（＝誤り）を数えて目で読む。知っている名前はその通より前の40通から拾う（AIX の出口と同じ材料）。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-property-name-verbatim.ts [--days=120] [--show=40]
import { createClient } from "@supabase/supabase-js";
import { enforceVerbatimPropertyNames, knownPropertyNamesFrom } from "../app/lib/property-name-verbatim";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "120")), SHOW = Number(arg("show", "40"));
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: M[] = [];
  for (let f = 0; f < 600_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, f + 999);
    if (error) throw error; rows.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, M[]>();
  for (const r of rows) { if (!by.has(r.conversation_id)) by.set(r.conversation_id, []); by.get(r.conversation_id)!.push(r); }
  let n = 0, aix = 0, fixed = 0, fixedAix = 0, shown = 0;
  for (const [cid, ms] of by) {
    if (isTestConversation(cid)) continue;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.sender === "customer" || !(m.text ?? "").trim()) continue;
      n++; if (m.is_aix_generated) aix++;
      // 知っている名前は「資料の形」の通（AIX の物件の文＝🌟の見出し・【名前 号室】）からだけ拾う（手打ちの綴りの揺れを正解にしない）
      const known = knownPropertyNamesFrom(ms.slice(Math.max(0, i - 40), i).filter((x) => x.is_aix_generated).map((x) => x.text));
      const r = enforceVerbatimPropertyNames(m.text ?? "", known);
      if (!r.fixes.length) continue;
      fixed++; if (m.is_aix_generated) fixedAix++;
      if (shown++ < SHOW) console.log(`${cid.slice(0, 8)} ${m.is_aix_generated ? "AIX" : "手"} ${r.fixes.map((f) => `「${f.from}」→「${f.to}」`).join(" ")}｜${(m.text ?? "").replace(/\n/g, " / ").slice(0, 80)}`);
    }
  }
  console.log(`\nスタッフの送信 ${n}（うち AIX ${aix}）・直してしまう通 ${fixed}（うち AIX ${fixedAix}）`);
})();
