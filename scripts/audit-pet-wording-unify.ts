// scripts/audit-pet-wording-unify.ts — 「ペットの部分だけペット飼育可能に統一」（pet-wording.ts 2026-10-09 版）を、
//   こちらの送信全部・AI の下書き・AIX の生成文・テンプレートに当てて、変わる箇所の前後を1つずつ並べる（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-pet-wording-unify.ts [--keep]   （--keep で「そのまま」の箇所も出す）
import { createClient } from "@supabase/supabase-js";
import { normalizePetWording } from "../app/lib/pet-wording";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
const KEEP = process.argv.includes("--keep");
(async () => {
  const src: Array<{ where: string; text: string }> = [];
  for (const r of await readAll((f, t) => sb.from("messages").select("text").neq("sender", "customer").ilike("text", "%ペット%").range(f, t))) src.push({ where: "送信", text: r.text });
  for (const r of await readAll((f, t) => sb.from("ai_reply_examples").select("ai_draft").ilike("ai_draft", "%ペット%").range(f, t))) src.push({ where: "下書き", text: r.ai_draft });
  for (const r of await readAll((f, t) => sb.from("aix_usage_logs").select("generated_text").ilike("generated_text", "%ペット%").range(f, t))) src.push({ where: "AIX", text: r.generated_text });
  for (const r of await readAll((f, t) => sb.from("templates").select("text").ilike("text", "%ペット%").range(f, t))) src.push({ where: "テンプレ", text: r.text });
  let changedMsgs = 0;
  const seen = new Map<string, number>();
  const lines: string[] = [];
  for (const s of src) {
    const r = normalizePetWording(s.text ?? "");
    if (r.fixed.length) changedMsgs++;
    // 「ペット」の出る箇所ごとに、前後を元と直した後で並べる（位置は元の文で取り、直した文は同じ前置きから探す）
    for (const m of [...(s.text ?? "").matchAll(/ペット/g)]) {
      const i = m.index ?? 0;
      const before = (s.text ?? "").slice(Math.max(0, i - 10), i + 22).replace(/\n/g, "⏎");
      const head = (s.text ?? "").slice(0, i);
      const after = r.text.startsWith(head) ? r.text.slice(Math.max(0, i - 10), i + 22).replace(/\n/g, "⏎") : "(前で変化)";
      const changed = before !== after;
      if (!changed && !KEEP) continue;
      const key = `${changed ? "★" : " "}${before}→${after}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (seen.get(key) === 1) lines.push(`${changed ? "★変える" : "  そのまま"} [${s.where}] ${before}${changed ? `\n           → ${after}` : ""}`);
    }
  }
  for (const l of lines) console.log(l);
  console.log(`\n通 ${src.length}・変わる通 ${changedMsgs}・変わる箇所（重複を除く）${lines.filter((l) => l.startsWith("★")).length}`);
})();
