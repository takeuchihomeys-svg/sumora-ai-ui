// 足した「これより前にお伝えしたこと」を実物の会話に当てて、入る行を目で読む（読み取りのみ・全件監査）
// 2026-09-23 竹内「①から着手する／AIXで何を押して送っているかも記憶にかけあわせたら」
//
// 設計知見「監査で止める」「件数だけ見ない・目で読む」に従い、
//   ① 何会話で行が足されるか・何行増えるか（トークンの増え方）
//   ② 足される行の**鮮度**（古すぎる事実を「もう伝えた」として渡していないか）
//   ③ 実物の行を出して目で読む
//
// 実行: npx tsx --env-file=.env.local scripts/audit-ledger-digest-apply.ts [DAYS=60] [SHOW_N=12]
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger, buildActionLedgerNote, droppedKindDigest } from "../app/lib/action-ledger";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
);
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null };
type Aix = { conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string; sent_at: string | null; line_message_id: string | null; property_names: string[] | null; estimate_sent: boolean | null; template_name: string | null };
const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

async function page<T>(table: string, cols: string, since: string): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(`${table}: ${error.message}`); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const SHOW_N = Number(process.env.SHOW_N ?? 12);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs = await page<Msg>("messages", "conversation_id, sender, text, created_at, is_aix_generated, line_message_id", since);
  const aix = await page<Aix>("aix_usage_logs", "conversation_id, aix_type, check_pattern, created_at, sent_at, line_message_id, property_names, estimate_sent, template_name", since);
  const { data: convRows } = await sb.from("conversations").select("id, customer_name").limit(5000);
  const nameOf = new Map(((convRows ?? []) as Array<{ id: string; customer_name: string | null }>).map((c) => [c.id, c.customer_name]));

  const byM = new Map<string, Msg[]>(); for (const m of msgs) { if (!byM.has(m.conversation_id)) byM.set(m.conversation_id, []); byM.get(m.conversation_id)!.push(m); }
  const byA = new Map<string, Aix[]>(); for (const a of aix) { if (!byA.has(a.conversation_id)) byA.set(a.conversation_id, []); byA.get(a.conversation_id)!.push(a); }

  let withDigest = 0, linesTotal = 0;
  const lineCounts: number[] = [];
  const ageHours: number[] = [];
  const samples: Array<{ conv: string; block: string; days: number }> = [];
  const kindAges = new Map<string, number[]>();

  for (const cid of byM.keys()) {
    const list = byM.get(cid) ?? [];
    const lastAt = Date.parse(list[list.length - 1]?.created_at ?? "");
    const ledger = buildActionLedger({
      recentAixRows: (byA.get(cid) ?? []).map((l) => ({
        aix_type: l.aix_type, check_pattern: l.check_pattern, created_at: l.created_at, sent_at: l.sent_at,
        line_message_id: l.line_message_id, property_names: l.property_names, estimate_sent: l.estimate_sent,
        template_name: l.template_name, generated_text: null,
      })),
      messages: list.map((m) => ({ sender: m.sender ?? "customer", text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated, lineMessageId: m.line_message_id })),
      lineTasks: [],
      lastCustomerAt: [...list].reverse().find((m) => m.sender === "customer")?.created_at ?? null,
    });
    const nonMedia = ledger.entries.filter((e) => e.kind !== "media_sent");
    const digest = droppedKindDigest(nonMedia, nonMedia.slice(-6));
    if (!digest.length) continue;
    withDigest++; linesTotal += digest.length; lineCounts.push(digest.length);
    for (const e of digest) {
      const h = (lastAt - Date.parse(e.at ?? "")) / 3600_000;
      if (Number.isFinite(h)) { ageHours.push(h); if (!kindAges.has(e.kind)) kindAges.set(e.kind, []); kindAges.get(e.kind)!.push(h); }
    }
    const note = buildActionLedgerNote(ledger, { customerName: nameOf.get(cid) ?? undefined });
    const block = (note.split("これより前にお伝えしたこと")[1] ?? "").split("→ 同じ内容を")[0];
    const oldestDays = Math.max(...digest.map((e) => (lastAt - Date.parse(e.at ?? "")) / 86400_000).filter(Number.isFinite));
    samples.push({ conv: cid.slice(0, 8), block: block.trim(), days: oldestDays });
  }

  console.log(`① 行が足される会話: ${withDigest}件 ／ 合計 ${linesTotal}行`);
  console.log(`   1会話あたり 中央値 ${med(lineCounts)}行・最大 ${Math.max(...lineCounts)}行（種類は有限なので上限がある）`);
  console.log(`   増えるトークンの目安: 1行およそ 20 トークン → 中央値で約 ${med(lineCounts) * 20} トークン／回`);

  console.log(`\n② 足す行の鮮度（会話の最後の発言から見て、どれだけ前の事実か）`);
  ageHours.sort((a, b) => a - b);
  const q = (p: number) => ageHours[Math.floor(ageHours.length * p)] ?? 0;
  console.log(`   中央値 ${(q(0.5) / 24).toFixed(1)}日 ／ 75% ${(q(0.75) / 24).toFixed(1)}日 ／ 90% ${(q(0.9) / 24).toFixed(1)}日 ／ 最大 ${(ageHours[ageHours.length - 1] / 24).toFixed(1)}日`);
  console.log(`   種類ごとの中央値:`);
  for (const [k, v] of [...kindAges].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    console.log(`   - ${k.padEnd(24)} ${v.length}件・中央値 ${(med(v) / 24).toFixed(1)}日`);
  }

  console.log(`\n③ 実物（古い順に ${SHOW_N} 件・目で読む）`);
  for (const s of samples.sort((a, b) => b.days - a.days).slice(0, SHOW_N)) {
    console.log(`\n   ── ${s.conv}（一番古い行は ${s.days.toFixed(0)}日前）`);
    for (const l of s.block.split("\n").map((x) => x.trim()).filter((x) => x.startsWith("・"))) console.log(`      ${l}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
