// 1行目が「お客様の発言をかぎかっこで引用しただけの行」（「その後どうなりましたか？」）の実送信の件数（誤削除0の確認・読み取りのみ）
// 2026-09-22 YUMA の下書き1行目に出た（約束から130時間・催促の場面）
// 実行: npx tsx --env-file=.env.local scripts/audit-quote-only-line.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const RE = /^\s*「[^」\n]{1,80}」\s*$/;

async function main() {
  let n = 0; const hit: string[] = [];
  for (let p = 0; p < 40; p++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff").like("text", "「%").range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null }>;
    n += r.length;
    for (const x of r) { const first = (x.text ?? "").split("\n")[0] ?? ""; const rest = (x.text ?? "").split("\n").slice(1).join("").trim(); if (RE.test(first) && rest) hit.push(first.slice(0, 60)); }
    if (r.length < 1000) break;
  }
  console.log(`「で始まるスタッフ送信 ${n}通 ／ 1行目が引用だけで後ろに本文が続く ${hit.length}通`);
  for (const h of hit.slice(0, 10)) console.log("   ", h);
}
main().catch((e) => { console.error(e); process.exit(1); });
