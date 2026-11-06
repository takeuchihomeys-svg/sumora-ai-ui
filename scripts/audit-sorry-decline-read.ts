// scripts/audit-sorry-decline-read.ts — 型3 の網（app/lib/sorry-decline-read.readSorryDecline）を本番の過去のお客様の発言に当て、当たった番と竹内さんの一手を数える（読むだけ・LLM なし）
//   実行: npx tsx --env-file=.env.local scripts/audit-sorry-decline-read.ts [--days=90] [--show=40]
import { createClient } from "@supabase/supabase-js";
import { readSorryDecline } from "../app/lib/sorry-decline-read";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "90")), show = Number(arg("show", "40"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type M = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };

(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const loose = ["申し訳", "すみません", "すいません", "ごめん", "せっかく", "お手数", "見送", "大丈夫です", "ありがとう", "有難う"];
  const cands = new Map<string, M>();
  for (const w of loose) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, staff_writer, is_aix_generated")
      .eq("sender", "customer").gte("created_at", since).ilike("text", `%${w}%`).limit(2000);
    if (error) throw error;
    for (const m of (data ?? []) as M[]) if ((m.text ?? "").length <= 120) cands.set(m.id, m);
  }
  const tally: Record<string, Record<string, number>> = {};
  let shown = 0;
  for (const m of [...cands.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const { data: around } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, staff_writer, is_aix_generated")
      .eq("conversation_id", m.conversation_id).gte("created_at", new Date(Date.parse(m.created_at) - 3 * 86400_000).toISOString())
      .lte("created_at", new Date(Date.parse(m.created_at) + 86400_000).toISOString()).order("created_at", { ascending: true }).limit(300);
    const rows = (around ?? []) as M[];
    const prev = [...rows].reverse().find((r) => r.sender !== "customer" && r.created_at < m.created_at && r.text && r.text !== "[画像]");
    const kind = readSorryDecline({ customerText: m.text, prevStaffText: prev?.text ?? "" });
    if (!kind) continue;
    const nextCust = rows.find((r) => r.sender === "customer" && r.created_at > m.created_at && Date.parse(r.created_at) - Date.parse(m.created_at) > 60_000);
    const reply = rows.find((r) => r.sender !== "customer" && r.created_at > m.created_at && (!nextCust || r.created_at < nextCust.created_at) && r.text && r.text !== "[画像]");
    if (reply && reply.staff_writer !== "takeuchi") continue; // 竹内さんの番だけ
    if (!reply && !rows.some((r) => r.sender !== "customer" && r.created_at > m.created_at && r.staff_writer === "takeuchi")) continue;
    const t = reply?.text ?? "";
    const move = !reply ? "返さない" : reply.is_aix_generated ? "AIX" : /内[覧見]|ご案内(?:可能|出来|でき)|ご都合/.test(t) && !/優先して|決まりましたら/.test(t) ? "内覧に誘う" : /引き続き|新着|お探し|ピックアップ|探させ|お送りさせ|全力/.test(t) ? "受け止め＋継続の約束" : "受け止めの返信";
    (tally[kind] ??= {})[move] = (tally[kind][move] ?? 0) + 1;
    if (shown++ < show) console.log(`${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} [${kind}・${move}] 「${(m.text ?? "").replace(/\n/g, " ").slice(0, 70)}」→「${t.replace(/\n/g, " ").slice(0, 70)}」`);
  }
  console.log(`\n候補 ${cands.size}通・竹内さんの番の内訳:`, JSON.stringify(tally));
})().catch((e) => { console.error(e); process.exit(1); });
