// scripts/audit-example-pii-exit.ts — 出口の歯止め（redactExampleSpansInPrompt）を全手本に当てて、伏せた数が判定と一致するか・伏せた後に個人情報が残らないかを見る（読み取りのみ・形だけ出す）
// 実行: npx tsx --env-file=.env.local scripts/audit-example-pii-exit.ts
import { createClient } from "@supabase/supabase-js";
import { redactExampleSpansInPrompt, examplePiiReason, sanitizeExampleText } from "../app/lib/example-pii-guard";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const sk = (s: string) => s.replace(/\d/g, "9").replace(/[A-Za-z]/g, "a").replace(/[一-鿿々]/g, "○").replace(/\n/g, "⏎").slice(0, 160);
(async () => {
  const out: any[] = [];
  for (let p = 0; p < 10; p++) { const { data: d } = await sb.from("ai_reply_examples").select("id, customer_message, sent_reply").order("id").range(p*1000, p*1000+999); out.push(...(d ?? [])); if ((d ?? []).length < 1000) break; }
  let changedRows = 0, expected = 0, mismatch = 0, leftover = 0; const samples: string[] = [];
  for (const r of out) {
    const block = `[例1]\nお客様: 「${r.customer_message ?? ""}」\nスモラ: 「${r.sent_reply ?? ""}」\n\n[例2]\nお客様: 「はい」\nスモラ: 「ありがとうございます」`;
    const res = redactExampleSpansInPrompt(block);
    const exp = (examplePiiReason(r.customer_message) ? 1 : 0) + (examplePiiReason(r.sent_reply) ? 1 : 0);
    expected += exp; if (res.redacted) changedRows++;
    if (res.redacted !== exp) { mismatch++; if (samples.length < 10) samples.push(`MISMATCH ${r.id.slice(0,8)} got=${res.redacted} exp=${exp}`); }
    if (res.redacted && (examplePiiReason(res.text.replace(/\[例2\][\s\S]*$/, "")))) { leftover++; if (samples.length < 20) samples.push(`LEFT ${r.id.slice(0,8)} ${sk(res.text)}`); }
    if (res.redacted && samples.length < 30 && false) samples.push(`AFTER ${r.id.slice(0,8)} ${sk(res.text)}`);
  }
  console.log({ rows: out.length, changedRows, expected, mismatch, leftover });
  console.log(samples.join("\n"));
})();
