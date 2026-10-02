// scripts/audit-grounded-amount.ts
// 2026-10-02 ⑫: 見積金額内訳ゲートの「会話に既に出ている金額の引用」免除（validate-reply.isGroundedAmountSentence）で通るようになる文を目で読む。
//   スタッフの手打ち 60日の文のうち、金額＋費用の語を含み、金額が全部 直近25通にそのまま有る文を出す（根拠の通の一部も並べる）。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-grounded-amount.ts [--days=60] [--show=30]
import { createClient } from "@supabase/supabase-js";
import { isGroundedAmountSentence, GROUND_SEP } from "../app/lib/validate-reply";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "60")), SHOW = Number(arg("show", "30"));
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
  let cand = 0, grounded = 0, shown = 0;
  for (const [cid, ms] of by) {
    if (isTestConversation(cid)) continue;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.sender === "customer" || m.is_aix_generated || !(m.text ?? "").trim()) continue;
      const ground = ms.slice(Math.max(0, i - 25), i).map((x) => x.text ?? "").join(GROUND_SEP);
      for (const s of (m.text ?? "").split(/(?<=[。！!？?\n])/)) {
        if (!(/[0-9０-９][0-9０-９,，．.]*\s*(?:万\s*)?円/.test(s) && /(?:初期費用|敷金|礼金|仲介手数料|保証料|前?家賃|管理費|共益費|合計|総額|割引|節約)/.test(s))) continue;
        cand++;
        if (!isGroundedAmountSentence(s, ground)) continue;
        grounded++;
        if (shown++ < SHOW) {
          const amt = (s.normalize("NFKC").match(/[0-9][0-9,]*(?:\.[0-9]+)?\s*万?\s*円/) ?? [""])[0].replace(/,/g, "");
          const src = ground.normalize("NFKC").replace(/,/g, "").split("\n").find((l) => amt && l.includes(amt.replace(/\s/g, ""))) ?? "";
          console.log(`${cid.slice(0, 8)}｜文: ${s.trim().slice(0, 70)}\n          根拠: ${src.slice(0, 80)}`);
        }
      }
    }
  }
  console.log(`\n金額＋費用の語の文 ${cand}・そのうち金額が全部 直近25通に有る ${grounded}`);
})();
