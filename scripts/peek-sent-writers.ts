// 送った物件の「書く側」の確かめ（読み取りのみ・お客様の名前は出さない）
//   ① sent_properties に created_at 列があるか（line-webhook / line-tasks/complete が order に使っている）
//   ② sent_image_properties の source 別（直近14日）
//   ③ property_pickups の送った行 × sent_properties の突き合わせ（pdf_url の形・property_url の形）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

function normUrl(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  try { const u = new URL(s); if (u.hostname.toLowerCase().endsWith("vercel-storage.com")) return ""; return `${u.hostname.toLowerCase()}${u.pathname}`.replace(/\/+$/, "").toLowerCase(); } catch { return ""; }
}

async function main() {
  const c1 = await sb.from("sent_properties").select("id").order("created_at", { ascending: false }).limit(1);
  console.log("① sent_properties を created_at で並べる:", c1.error ? `エラー: ${c1.error.message}` : "OK（列あり）");

  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const sip: Array<{ source: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("sent_image_properties").select("source").gte("created_at", since).range(from, from + 999);
    sip.push(...((data ?? []) as Array<{ source: string | null }>));
    if (!data || data.length < 1000) break;
  }
  const by = new Map<string, number>();
  for (const r of sip) by.set(r.source ?? "-", (by.get(r.source ?? "-") ?? 0) + 1);
  console.log(`\n② sent_image_properties 14日 ${sip.length}行:`);
  for (const [k, v] of [...by.entries()].sort((a, z) => z[1] - a[1])) console.log(`  ${v}\t${k}`);

  const { data: pk, error: pkErr } = await sb.from("property_pickups")
    .select("id, status, pdf_url, conversation_id, property_customer_id, property_name, room_no, sent_at, sent_by")
    .order("id", { ascending: false }).limit(300);
  if (pkErr) { console.log("③ property_pickups:", pkErr.message); return; }
  const rows = (pk ?? []) as Array<Record<string, string | number | null>>;
  const st = new Map<string, number>();
  for (const r of rows) st.set(String(r.status), (st.get(String(r.status)) ?? 0) + 1);
  console.log(`\n③ property_pickups 直近${rows.length}行 status:`, Object.fromEntries(st));
  const withUrl = rows.filter((r) => r.pdf_url);
  console.log(`   pdf_url あり ${withUrl.length}行。例の形: ${withUrl[0] ? String(withUrl[0].pdf_url).replace(/[?#].*$/, "").slice(0, 60) : "-"}`);
  let rawHit = 0, normHit = 0, checked = 0;
  for (const r of withUrl.slice(0, 40)) {
    checked++;
    const raw = await sb.from("sent_properties").select("id", { count: "exact", head: true }).eq("property_url", String(r.pdf_url));
    const norm = await sb.from("sent_properties").select("id, source", { count: "exact" }).eq("property_url", normUrl(String(r.pdf_url)));
    if ((raw.count ?? 0) > 0) rawHit++;
    if ((norm.count ?? 0) > 0) normHit++;
  }
  console.log(`   sent_properties.property_url と一致（${checked}件中）: pdf_url そのまま=${rawHit} ／ 正規化（host+path）=${normHit}`);
  const sent = rows.filter((r) => r.status === "sent");
  console.log(`   送った行 ${sent.length}件（sent_by 別）:`, Object.fromEntries(sent.reduce((m, r) => m.set(String(r.sent_by), (m.get(String(r.sent_by)) ?? 0) + 1), new Map<string, number>())));
  for (const r of sent.slice(0, 10)) {
    const conv = r.conversation_id ? String(r.conversation_id) : null;
    if (!conv) continue;
    const { data: sp } = await sb.from("sent_properties").select("source, property_url, sent_at").eq("conversation_id", conv).gte("sent_at", new Date(Date.parse(String(r.sent_at)) - 86400_000).toISOString()).limit(50);
    const srcs = ((sp ?? []) as Array<{ source: string | null }>).reduce((m, x) => m.set(x.source ?? "-", (m.get(x.source ?? "-") ?? 0) + 1), new Map<string, number>());
    const { data: si } = await sb.from("sent_image_properties").select("source").eq("conversation_id", conv).gte("created_at", String(r.sent_at)).limit(50);
    const isrcs = ((si ?? []) as Array<{ source: string | null }>).reduce((m, x) => m.set(x.source ?? "-", (m.get(x.source ?? "-") ?? 0) + 1), new Map<string, number>());
    console.log(`   pickup#${r.id} 会話${conv.slice(0, 8)} → sent_properties(前後1日): ${JSON.stringify(Object.fromEntries(srcs))} ／ 送った後の画像記録: ${JSON.stringify(Object.fromEntries(isrcs))}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
