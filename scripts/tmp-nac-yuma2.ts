import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
async function main() {
  const pk = await sb.from("property_pickups").select("id, created_at, batch_id, site, rank, property_name, room_no, verdict, score, recommended, status, sent_at, seen_at, complete_group_id, complete_rank, search_mode, search_override, expired_at").eq("property_customer_id", PC).order("created_at", { ascending: false }).limit(200);
  const rows = (pk.data ?? []) as Array<Record<string, any>>;
  console.log("pickups", rows.length);
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const r of rows) { const k = `${r.complete_group_id ?? "-"} | ${r.batch_id} | ${r.site}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  for (const [k, rs] of groups) {
    const c = (v: string) => rs.filter((r) => r.verdict === v).length;
    console.log(`\n## ${k} n=${rs.length} first=${rs[rs.length-1].created_at} pass=${c("pass")} hold=${c("hold")} exclude=${c("exclude")} other=${rs.filter(r=>!["pass","hold","exclude"].includes(r.verdict)).map(r=>r.verdict).join("/")} mode=${[...new Set(rs.map(r=>r.search_mode))]} status=${[...new Set(rs.map(r=>r.status))]} seen=${rs.filter(r=>r.seen_at).length} ovr=${rs.some(r=>r.search_override)}`);
    for (const r of rs.sort((a,z)=>(a.complete_rank??a.rank)-(z.complete_rank??z.rank)).slice(0, 6)) console.log(`   #${r.id} r${r.rank}/c${r.complete_rank} ${r.property_name} ${r.room_no} ${r.verdict} ${r.score} rec=${r.recommended} ${r.status}${r.sent_at?" sent":""}${r.expired_at?" expired":""}`);
  }
  const cp = await sb.from("property_pickup_completions").select("group_id, created_at, trigger, mode, requested_by, status, item_ids, batch_ids, sites, best_id, best_basis, result, finished_at").eq("property_customer_id", PC).order("created_at", { ascending: false }).limit(5);
  console.log("\n== completions");
  for (const c of cp.data ?? []) console.log(JSON.stringify({ ...c, item_ids: (c as any).item_ids?.length, result: JSON.stringify((c as any).result).slice(0, 600) }));
  const sp = await sb.from("sent_properties").select("id, property_name, room_no, channel, delivery, source, sent_at, pickup_id, conversation_id").eq("property_customer_id", PC).order("sent_at", { ascending: false }).limit(12);
  console.log("\n== sent_properties", sp.error?.message ?? "");
  for (const s of sp.data ?? []) console.log(JSON.stringify(s));
  const conv = await sb.from("conversations").select("id, customer_name, property_customer_id, status, updated_at, last_sender, account").eq("id", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7").maybeSingle();
  console.log("\n== conv", JSON.stringify(conv.data));
  const n = await sb.from("property_pickup_notes").select("id, created_at, batch_id, text, author").eq("property_customer_id", PC).order("created_at", { ascending: false }).limit(5);
  console.log("\n== notes"); for (const x of n.data ?? []) console.log(JSON.stringify(x).slice(0, 300));
  // conversations with property_customer_id count
  const cnt = await sb.from("conversations").select("id", { count: "exact", head: true }).not("property_customer_id", "is", null);
  console.log("\nconvs linked:", cnt.count);
  const ms = await sb.from("messages").select("*").eq("conversation_id", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7").order("created_at", { ascending: false }).limit(3);
  console.log("\n== messages cols", ms.data?.[0] ? Object.keys(ms.data[0]).join(",") : ms.error?.message);
  const snd = await sb.from("messages").select("sender").eq("conversation_id", "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7").limit(1000);
  const sc = new Map<string, number>(); for (const m of snd.data ?? []) sc.set((m as any).sender, (sc.get((m as any).sender) ?? 0) + 1);
  console.log("senders", JSON.stringify([...sc]));
}
main().catch((e) => { console.error(e); process.exit(1); });
