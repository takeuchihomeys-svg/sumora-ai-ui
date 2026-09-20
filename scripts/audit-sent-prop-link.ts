// 送った物件は「誰に送ったか」分かる形で残っているか（読み取りのみ）
//
// 2026-09-20 竹内「これは次からちゃんとできるってことかな？」
//   log-aix-usage 経由は YUMA で動作確認済み（退去予定も残った）。
//   だが実測では sent_properties の 91% が source="line_group"（物件出しツール → LINE グループ）で、
//   conversation_id が 9.4% しか無かった。**会話に紐付かない物件は、ブレインも文生成も読めない**。
//   source ごとに「会話に辿れるか」を数えて、どこを繋げば竹内さんの狙いが完成するかを出す。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 20; p++) {
    const { data } = await sb.from("sent_properties")
      .select("id, conversation_id, property_customer_id, property_name, room_no, source, sent_at")
      .gte("sent_at", new Date(Date.now() - days * 86400_000).toISOString())
      .order("sent_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  console.log(`=== sent_properties ${rows.length}件（直近${days}日）— 「誰に送ったか」分かるか ===\n`);

  type B = { n: number; conv: number; pc: number; neither: number; room: number };
  const by = new Map<string, B>();
  for (const r of rows) {
    const s = String(r.source ?? "(null)");
    if (!by.has(s)) by.set(s, { n: 0, conv: 0, pc: 0, neither: 0, room: 0 });
    const b = by.get(s)!;
    b.n++;
    const hasConv = !!r.conversation_id;
    const hasPc = !!r.property_customer_id;
    if (hasConv) b.conv++;
    if (hasPc) b.pc++;
    if (!hasConv && !hasPc) b.neither++;
    if (String(r.room_no ?? "").trim()) b.room++;
  }
  console.log(`   ${"source".padEnd(28)} 件数   会話ID   物件顧客ID   どちらも無い   号室あり`);
  for (const [s, b] of [...by.entries()].sort((a, b2) => b2[1].n - a[1].n)) {
    const p = (x: number) => `${((x / b.n) * 100).toFixed(0)}%`.padStart(5);
    console.log(`   ${s.padEnd(28)} ${String(b.n).padStart(6)}  ${p(b.conv)}  ${p(b.pc)}      ${p(b.neither)}        ${p(b.room)}`);
  }

  // property_customer_id しか無い行は、会話に辿れるか（conversations.property_customer_id 経由）
  const pcOnly = rows.filter((r) => !r.conversation_id && r.property_customer_id);
  const pcIds = [...new Set(pcOnly.map((r) => String(r.property_customer_id)))];
  const reachable = new Set<string>();
  for (let i = 0; i < pcIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("property_customer_id").in("property_customer_id", pcIds.slice(i, i + 200));
    for (const c of ((data ?? []) as Array<{ property_customer_id: string | null }>)) if (c.property_customer_id) reachable.add(c.property_customer_id);
  }
  const rescued = pcOnly.filter((r) => reachable.has(String(r.property_customer_id))).length;
  console.log(`\n── 会話ID が無く 物件顧客ID だけの行: ${pcOnly.length}件`);
  console.log(`   そのうち conversations.property_customer_id で**会話に辿れる**: ${rescued}件 (${pcOnly.length ? ((rescued / pcOnly.length) * 100).toFixed(1) : "-"}%)`);
  console.log(`   → ブレイン・文生成は conversation_id と property_customer_id の**両方**で引けば、この分も読める`);

  // 最終的に「会話に辿れる物件」は何件か
  const direct = rows.filter((r) => !!r.conversation_id).length;
  console.log(`\n── まとめ: 会話に辿れる物件 ${direct + rescued}件 / ${rows.length}件 (${(((direct + rescued) / rows.length) * 100).toFixed(1)}%)`);
  console.log(`   内訳: conversation_id が直接ある ${direct}件 ＋ 物件顧客ID から辿れる ${rescued}件`);
  console.log(`   どちらでも辿れない: ${rows.length - direct - rescued}件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
