// scripts/audit-r12-pet-wording.ts — 「ペット相談可」→「ペット飼育可能」（pet-wording.ts）を、こちらの送信全部・AI の下書き・手本に当てて前後を目で読む（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-r12-pet-wording.ts
import { createClient } from "@supabase/supabase-js";
import { normalizePetWording } from "../app/lib/pet-wording";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
(async () => {
  const src: Array<{ where: string; text: string }> = [];
  for (const r of await readAll((f, t) => sb.from("messages").select("text, sender").neq("sender", "customer").ilike("text", "%ペット%相談%").range(f, t))) src.push({ where: "送信", text: r.text });
  for (const r of await readAll((f, t) => sb.from("ai_reply_examples").select("ai_draft, sent_reply").or("ai_draft.ilike.%ペット%相談%,sent_reply.ilike.%ペット%相談%").range(f, t))) { if (r.ai_draft) src.push({ where: "下書き", text: r.ai_draft }); if (r.sent_reply) src.push({ where: "手本", text: r.sent_reply }); }
  let changed = 0, total = 0;
  const seen = new Set<string>();
  for (const s of src) {
    total++;
    const r = normalizePetWording(s.text);
    for (const m of [...s.text.matchAll(/ペット(?:飼育)?(?:の)?相談[^\n]{0,14}/g)]) {
      const i = m.index ?? 0; const ctx = s.text.slice(Math.max(0, i - 12), i + 26).replace(/\n/g, "⏎");
      const after = r.text.slice(Math.max(0, i - 12), i + 26).replace(/\n/g, "⏎");
      const key = ctx; if (seen.has(key)) continue; seen.add(key);
      console.log(`${ctx === after ? "  そのまま" : "★変える "} [${s.where}] ${ctx}${ctx === after ? "" : `\n          → ${after}`}`);
    }
    if (r.fixed.length) changed++;
  }
  console.log(`\n通 ${total}・変わった通 ${changed}`);
})();
