// 新しい手本の関門（isCustomerFacingExample）を実データ全件に当てて、落ちる物を目で読む（読み取りのみ）
//
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
// 設計知見「全件監査で止める — 変換の前後を**目で読む**。件数だけ見ない」
import { createClient } from "@supabase/supabase-js";
import { isUsableExampleText, isCustomerFacingExample } from "../app/lib/example-hygiene";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 16; p++) {
    const { data } = await sb.from("ai_reply_examples")
      .select("id, sent_reply, conversation_state, aix_action, entry_source, is_starred, created_at")
      .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  const usable = rows.filter((r) => isUsableExampleText(String(r.sent_reply ?? "")));
  const dropped = usable.filter((r) => !isCustomerFacingExample(String(r.sent_reply ?? "")));
  console.log(`=== 手本 ${rows.length}件（既存の関門を通る ${usable.length}件）===`);
  console.log(`  新しい関門で落ちる: **${dropped.length}件**（${((dropped.length / usable.length) * 100).toFixed(2)}%）\n`);
  console.log(`--- 落ちる物を全部読む（誤削除が1件でもあれば入れない）---`);
  for (const r of dropped) {
    console.log(`\n[${String(r.created_at).slice(5, 16)}] state=${r.conversation_state} aix=${r.aix_action ?? "なし"} src=${r.entry_source} ☆=${r.is_starred}`);
    console.log(`  ${String(r.sent_reply ?? "").replace(/\n/g, " ／ ").slice(0, 190)}`);
  }

  // お客様へのLINE（messages.staff）にこの形が無いことを最終確認
  const sent: string[] = [];
  for (let p = 0; p < 16; p++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff").gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null }>;
    if (r.length === 0) break;
    for (const x of r) if (x.text) sent.push(x.text);
    if (r.length < 1000) break;
  }
  const sentDropped = sent.filter((t) => !isCustomerFacingExample(t));
  console.log(`\n=== お客様へのLINE ${sent.length}通 でこの関門に当たる: **${sentDropped.length}通** ===`);
  if (sentDropped.length === 0) console.log(`  ✅ 誤削除0（お客様に実際に送られた文は1通も落ちない）`);
  else for (const t of sentDropped.slice(0, 10)) console.log(`  🔴 ${t.replace(/\n/g, " ").slice(0, 120)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
