// scripts/audit-aix-check-staff-note.ts — AIX【物件確認した】のスタッフ向けの注記（NEXT_PUBLIC_AIX_CHECK_STAFF_NOTE）を本番の番に当てる（読むだけ・LLM なし）
//   60日の物件確認した（送った物）ごとに、その時点のお客様の条件・直前のお客様の発言から注記を作り、
//   その前後のスタッフの約束・報告の文（「〜の飼育可否も」「二人入居」）に同じ条件が出ているかを並べる（目で読む）。
//   実行: npx tsx --env-file=.env.local scripts/audit-aix-check-staff-note.ts [--days=60]
import { supabase } from "../app/lib/supabase-server";
import { checkResultStaffNotes } from "../app/lib/aix-check-staff-note";

const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 60);
(async () => {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const { data: logs } = await supabase.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "property_check_result").gte("created_at", since).order("created_at").range(0, 999);
  let withNote = 0, staffSaid = 0, staffSaidNoNote = 0;
  const pcCache = new Map<string, string>();
  for (const l of (logs ?? []) as Array<{ conversation_id: string; created_at: string }>) {
    let cond = pcCache.get(l.conversation_id);
    if (cond === undefined) {
      const { data: c } = await supabase.from("conversations").select("property_customer_id").eq("id", l.conversation_id).maybeSingle();
      const pcid = (c as { property_customer_id?: string | null } | null)?.property_customer_id;
      const { data: pc } = pcid ? await supabase.from("property_customers").select("preferences, other_requests, ng_points").eq("id", pcid).maybeSingle() : { data: null };
      const p = pc as { preferences?: string | null; other_requests?: string | null; ng_points?: string | null } | null;
      cond = [p?.preferences, p?.other_requests, p?.ng_points].filter(Boolean).join("、");
      pcCache.set(l.conversation_id, cond);
    }
    const { data: msgs } = await supabase.from("messages").select("sender, text, created_at").eq("conversation_id", l.conversation_id)
      .gte("created_at", new Date(Date.parse(l.created_at) - 7 * 86400e3).toISOString()).lte("created_at", l.created_at).order("created_at", { ascending: false }).range(0, 39);
    const ms = (msgs ?? []) as Array<{ sender: string; text: string | null }>;
    const cust = ms.filter((m) => m.sender === "customer").slice(0, 10).map((m) => m.text);
    const staffText = ms.filter((m) => m.sender === "staff").slice(0, 6).map((m) => m.text ?? "").join("\n");
    const notes = checkResultStaffNotes(cond, cust);
    const said = /飼育可否|ペット[^。\n]{0,10}(?:可否|可能か|確認)|(?:2|二)人入居[^。\n]{0,8}(?:可否|可能か|確認)/.test(staffText);
    if (notes.length) withNote++;
    if (said) { staffSaid++; if (!notes.length) staffSaidNoNote++; }
    if (notes.length || said) console.log(`--- ${l.created_at.slice(0, 16)} ${l.conversation_id.slice(0, 8)} 注記: ${notes.join(" ／ ") || "（なし）"} | スタッフが一緒に確認と書いた: ${said}`);
  }
  console.log(`\n物件確認した ${logs?.length ?? 0}回・注記が出る ${withNote}・スタッフが条件の確認も書いた ${staffSaid}（うち注記なし ${staffSaidNoNote}）`);
  process.exit(0);
})();
