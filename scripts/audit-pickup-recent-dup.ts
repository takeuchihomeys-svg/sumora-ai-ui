// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-recent-dup.ts [--days=30]
// 2026-10-01 回をまたいだ重複（pickup-recent-dup.ts）を過去の売上サポの行に当て、外れる行を全部出す（読むだけ）。
//   見る所: 外れる行がすべて二重送信か（日を空けた出し直し・お客様に送った行 status=sent を巻き込んでいないか）
import { createClient } from "@supabase/supabase-js";
import { recentDuplicateIndexes, type RecentPickupRow } from "../app/lib/pickup-recent-dup";

type Row = RecentPickupRow & { id: number; property_customer_id: string | null; summary_text: string | null; status: string | null; batch_id: string | null };

async function main() {
  const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").slice(7)) || 30;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const all: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("property_pickups").select("id, property_customer_id, property_name, room_no, pdf_url, created_at, summary_text, status, batch_id")
      .gte("created_at", since).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const byCust = new Map<string, Row[]>();
  for (const r of all) if (r.property_customer_id) { const a = byCust.get(r.property_customer_id) ?? []; a.push(r); byCust.set(r.property_customer_id, a); }
  let hit = 0, hitSent = 0;
  for (const [cid, rows] of byCust) {
    // 回（batch_id）ごとに、その回より前の行と照らす
    const batches = [...new Set(rows.map((r) => r.batch_id ?? `#${r.id}`))];
    for (const b of batches) {
      const cur = rows.filter((r) => (r.batch_id ?? `#${r.id}`) === b);
      const t0 = Math.min(...cur.map((r) => Date.parse(r.created_at)));
      const prev = rows.filter((r) => Date.parse(r.created_at) < t0);
      const dup = recentDuplicateIndexes(cur.map((r) => r.summary_text ?? ""), cur.map((r) => r.pdf_url), prev, t0);
      for (const i of dup) {
        hit++;
        const r = cur[i];
        if (r.status === "sent") hitSent++;
        const p = prev.filter((x) => x.property_name === r.property_name).map((x) => x.created_at.slice(5, 19)).pop();
        console.log(`外す: ${cid.slice(0, 8)} #${r.id} ${r.property_name} ${r.room_no ?? ""} ${r.created_at.slice(5, 19)} 前の行 ${p ?? "-"} status=${r.status}`);
      }
    }
  }
  console.log(`\n${days}日・${all.length}行 → 外れる ${hit}行（うちお客様に送った行 ${hitSent}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
