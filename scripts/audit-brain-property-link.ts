// scripts/audit-brain-property-link.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-property-link.ts [--days=30]
//
// 2026-09-20 竹内「ブレインにもれがあるのか。ここで物件把握できていなかったら文にすれ違いが起きる」
//
// ブレインは【すでに送付済みの物件】を **property_customer_id** で引いている（conversation_id ではない）:
//   brain-core.ts: propertyCustomerId ? supabase.from("sent_properties").eq("property_customer_id", …) : null
// つまり **物件顧客に紐付いていない会話では、ブレインは物件を1件も見ない**。
// current_property は「実在ゲート通過値のみ・創作は null」なので、ここが空だと連鎖して null になる。
// どこで切れているかを段階で数える。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);
const SENT_RE = /🌟\s*[^\s\n]{2,}|【[^】]{2,40}[0-9０-９]{2,4}号室】|[^\s\n、。]{2,30}\s*[0-9０-９]{2,4}号室/;

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data: convs } = await sb.from("conversations")
    .select("id, customer_name, status, property_customer_id, suggested_aix_meta")
    .gte("updated_at", since).order("updated_at", { ascending: false }).limit(400);
  const list = (convs ?? []) as Array<Record<string, unknown>>;

  let nSent = 0, nLinked = 0, nSpByPc = 0, nSpByConv = 0, nCur = 0;
  const notLinked: Array<{ name: string; status: string }> = [];
  const linkedButEmpty: Array<{ name: string; status: string }> = [];

  for (const c of list) {
    const { data: msgs } = await sb.from("messages").select("sender, text")
      .eq("conversation_id", c.id as string).order("created_at", { ascending: false }).limit(80);
    const staffJoined = ((msgs ?? []) as Array<{ sender: string; text: string | null }>)
      .filter((m) => m.sender !== "customer").map((m) => m.text ?? "").join("\n");
    if (!SENT_RE.test(staffJoined)) continue;
    nSent++;

    const pcId = c.property_customer_id as string | null;
    if (pcId) {
      nLinked++;
      const { count } = await sb.from("sent_properties")
        .select("id", { count: "exact", head: true }).eq("property_customer_id", pcId);
      if ((count ?? 0) > 0) nSpByPc++;
      else linkedButEmpty.push({ name: String(c.customer_name), status: String(c.status ?? "") });
    } else {
      notLinked.push({ name: String(c.customer_name), status: String(c.status ?? "") });
    }
    const { count: byConv } = await sb.from("sent_properties")
      .select("id", { count: "exact", head: true }).eq("conversation_id", c.id as string);
    if ((byConv ?? 0) > 0) nSpByConv++;
    const meta = c.suggested_aix_meta as Record<string, unknown> | null;
    if (String(meta?.current_property ?? "").trim()) nCur++;
  }

  const pct = (n: number) => `${Math.round((100 * n) / Math.max(nSent, 1))}%`;
  console.log(`=== 直近${DAYS}日・物件を送っている会話 ${nSent}件 ===\n`);
  console.log(`  ① property_customer_id に紐付いている          ${String(nLinked).padStart(3)}件 (${pct(nLinked)})`);
  console.log(`     └ **紐付いていない（ブレインは物件を1件も見ない）${String(nSent - nLinked).padStart(3)}件 (${pct(nSent - nLinked)})**`);
  console.log(`  ② 紐付き先に sent_properties がある             ${String(nSpByPc).padStart(3)}件 (${pct(nSpByPc)})  ← ブレインが実際に見る数`);
  console.log(`  （参考）conversation_id で引いた場合            ${String(nSpByConv).padStart(3)}件 (${pct(nSpByConv)})`);
  console.log(`  ③ current_property に入っている                ${String(nCur).padStart(3)}件 (${pct(nCur)})`);

  console.log(`\n--- ①で紐付いていない会話（先頭15）---`);
  for (const x of notLinked.slice(0, 15)) console.log(`  ${x.name.padEnd(16)} [${x.status}]`);
  if (notLinked.length > 15) console.log(`  …ほか ${notLinked.length - 15}件`);
  console.log(`\n--- ②紐付いているのに sent_properties が空（先頭10）---`);
  for (const x of linkedButEmpty.slice(0, 10)) console.log(`  ${x.name.padEnd(16)} [${x.status}]`);
  if (linkedButEmpty.length > 10) console.log(`  …ほか ${linkedButEmpty.length - 10}件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
