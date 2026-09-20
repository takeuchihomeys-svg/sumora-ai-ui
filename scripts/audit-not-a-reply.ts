// scripts/audit-not-a-reply.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-not-a-reply.ts
//
// 2026-09-20 竹内「色んなパターンでバグや変な言い回しになっていないか確認」:
//   isNotACustomerReply（お客様への返信ではない文を丸ごと落とす関門）に形を足したので、
//   **スタッフの実送信を1通も落としていないか**を全件で確かめる。
//   この関門は文を丸ごと捨てるので、誤検出0でなければ入れてはいけない（設計知見）。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { isNotACustomerReply, stripMetaNarration } from "../app/lib/meta-narration";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const rows: Array<{ text: string; created_at: string }> = [];
  for (let page = 0; ; page++) {
    const { data } = await sb.from("messages").select("text, created_at").eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null; created_at: string }>;
    if (r.length === 0) break;
    for (const x of r) if (x.text) rows.push({ text: x.text, created_at: x.created_at });
    if (r.length < 1000) break;
    if (page > 14) break;
  }
  console.log(`=== スタッフの実送信365日 ${rows.length}通 に関門を当てる ===\n`);

  const dropped = rows.filter((r) => isNotACustomerReply(r.text));
  console.log(`  isNotACustomerReply（文を丸ごと落とす）で落ちる: **${dropped.length}通**`);
  for (const d of dropped) {
    console.log(`\n[${String(d.created_at).slice(0, 16)}]`);
    console.log(d.text.split("\n").map((l) => `      ${l}`).join("\n"));
  }
  if (dropped.length === 0) console.log(`  ✅ 誤検出0`);

  const stripped = rows.filter((r) => stripMetaNarration(r.text).removed.length > 0);
  console.log(`\n  stripMetaNarration（行を落とす）で変わる: ${stripped.length}通`);
  for (const s of stripped.slice(0, 10)) {
    const m = stripMetaNarration(s.text);
    console.log(`\n[${String(s.created_at).slice(0, 16)}] 落とした行: ${m.removed.map((x) => JSON.stringify(x.slice(0, 60))).join(" / ")}`);
  }
  if (stripped.length > 10) console.log(`\n  …ほか ${stripped.length - 10}通`);
}
main().catch((e) => { console.error(e); process.exit(1); });
