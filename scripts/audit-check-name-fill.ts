// scripts/audit-check-name-fill.ts — 物件名の記録が空の AIX【物件確認した】を、その会話で直前にお客様が送ってきた物件と突き合わせ、1件に決まる番を数える（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（統括役・竹内さん「物件確認したのところもちゃんと物件把握できるようにする。お客さんから送ってきた物件をちゃんと理解できていればここは改善される」）。
//   元: customer-sent-property.collectCustomerSentProperties（お客様の画像の書き起こし・ポータルの URL）・customer_image_records（G・11/20〜）・
//       own-property-match の照合はこちらが送った物件と同じかを見る物（ここでは名前の候補には足さない）。ページは開かない（--pages の時だけ）。
//   1件に決まる＝押す前 72時間のお客様の持ち込みの名前（号室まで）が1つだけ。2つ以上・0 は決まらない（推測で埋めない）。
//   文は出さない（会話の頭6字・型・件数だけ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-check-name-fill.ts [--days=30] [--hours=72]
import { createClient } from "@supabase/supabase-js";
import { collectCustomerSentProperties } from "../app/lib/customer-sent-property";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const key = (s: string) => s.normalize("NFKC").replace(/[\s　・]/g, "").toLowerCase();
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "30")) || 30, hours = Number(arg("hours", "72")) || 72;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data, error } = await sb.from("aix_usage_logs").select("id, conversation_id, check_pattern, property_names, sent_at, created_at").eq("aix_type", "property_check_result").gte("sent_at", since).limit(1000);
  if (error) throw new Error(error.message);
  const empty = ((data ?? []) as Array<{ id: string; conversation_id: string; check_pattern: string | null; property_names: string[] | null; sent_at: string | null; created_at: string }>)
    .filter((r) => !isTestConversation(r.conversation_id) && !isNoLineTestConversation(r.conversation_id) && !(r.property_names ?? []).length);
  const tally: Record<string, number> = {};
  for (const r of empty) {
    const at = Date.parse(r.sent_at ?? r.created_at);
    const from = new Date(at - hours * 36e5).toISOString(), to = new Date(at).toISOString();
    const [mq, iq] = await Promise.all([
      sb.from("messages").select("sender, text, image_type, created_at").eq("conversation_id", r.conversation_id).gte("created_at", from).lt("created_at", to).order("created_at").limit(300),
      sb.from("customer_image_records").select("property_name, room_no, ours_kind").eq("conversation_id", r.conversation_id).gte("created_at", from).lt("created_at", to).limit(50),
    ]);
    const { items, stats } = collectCustomerSentProperties((mq.data ?? []) as never, { limit: 10 });
    const names = new Set<string>();
    for (const x of items) if (x.name) names.add(key(x.name));
    for (const x of (iq.data ?? []) as Array<{ property_name: string | null; room_no: string | null; ours_kind: string | null }>) if (x.property_name && !x.ours_kind) names.add(key(`${x.property_name}${x.room_no ?? ""}`));
    const kind = names.size === 1 ? "1件に決まる" : names.size > 1 ? "2件以上" : items.length ? "持ち込みはあるが名前が読めない" : stats.urls || stats.images ? "画像・URL はあるが物件と読めない" : "持ち込みなし";
    tally[`${r.check_pattern ?? "-"}|${kind}`] = (tally[`${r.check_pattern ?? "-"}|${kind}`] ?? 0) + 1;
    tally[`計|${kind}`] = (tally[`計|${kind}`] ?? 0) + 1;
    console.log(r.conversation_id.slice(0, 6), r.check_pattern, kind, `items=${items.length}`, `urls=${stats.urls}`, `images=${stats.images}`);
  }
  console.log(`物件名が空の物件確認した ${empty.length}番（${days}日・押す前 ${hours}時間）`);
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k}: ${v}`);
})().catch((e) => { console.error(e); process.exit(1); });
