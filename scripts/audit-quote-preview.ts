// 引用の枠（app/lib/quote-preview.ts）を直近の実物の引用返信に当てる（読むだけ・書き込みなし）
// 2026-10-07 Ryoichi kiritsuke: 「↩ [引用] [画像]」としか出なかった。サムネイル・物件名がどれだけ出るか／同じ流れで複数を引用した数
// 実行: npx tsx --env-file=.env.local scripts/audit-quote-preview.ts --days=60
import { createClient } from "@supabase/supabase-js";
import { buildQuotePreview, labelsFromSentRows } from "../app/lib/quote-preview";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 60);
(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<{ conversation_id: string; text: string | null; quoted_message_id: string; created_at: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("messages").select("conversation_id, text, quoted_message_id, created_at").eq("sender", "customer").not("quoted_message_id", "is", null).gte("created_at", since).order("created_at").range(from, from + 999);
    rows.push(...((data ?? []) as typeof rows)); if (!data || data.length < 1000) break;
  }
  const ids = [...new Set(rows.map((r) => r.quoted_message_id))];
  const qmap = new Map<string, { sender: string; text: string | null; image_url: string | null; image_expires_at: string | null; conversation_id: string }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("messages").select("line_message_id, sender, text, image_url, image_expires_at, conversation_id").in("line_message_id", ids.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ line_message_id: string } & typeof qmap extends Map<string, infer V> ? any : never>) qmap.set(r.line_message_id, r);
  }
  const urls = [...new Set([...qmap.values()].filter((q) => q.sender !== "customer" && q.image_url).map((q) => q.image_url as string))];
  const labelRows: Array<{ image_url: string | null; property_name: string | null; room_no: string | null }> = [];
  for (const t of ["sent_image_properties", "sent_properties"]) {
    for (let i = 0; i < urls.length; i += 20) {
      const { data, error } = await sb.from(t).select("image_url, property_name, room_no").in("image_url", urls.slice(i, i + 20)); if (error) console.warn(t, error.message);
      labelRows.push(...((data ?? []) as typeof labelRows));
    }
  }
  const labels = labelsFromSentRows(labelRows);
  const c = { total: rows.length, missing: 0, staffImage: 0, staffImageThumb: 0, staffImageLabel: 0, staffImageGone: 0, custImage: 0, text: 0 };
  const samples: string[] = [];
  for (const r of rows) {
    const q = qmap.get(r.quoted_message_id);
    const p = buildQuotePreview(q ? { sender: q.sender, text: q.text, imageUrl: q.image_url, imageExpiresAt: q.image_expires_at, propertyLabel: q.image_url ? labels.get(q.image_url) ?? null : null } : undefined, { account: "sumora" });
    if (p.kind === "missing") { c.missing++; continue; }
    if (p.kind === "text") { c.text++; continue; }
    if (q!.sender === "customer") { c.custImage++; continue; }
    c.staffImage++; if (p.thumbUrl) c.staffImageThumb++; if (p.propertyLabel) c.staffImageLabel++; if (p.imageGone) c.staffImageGone++;
    if (samples.length < 12) samples.push(`  「${(r.text ?? "").replace(/\n/g, " ").slice(0, 24)}」→ ${p.who}／${p.snippet}${p.propertyLabel ? `／🏠 ${p.propertyLabel}` : "／（物件名なし）"}`);
  }
  // 同じ流れ（続けてのお客様の発言・10分以内）で2通以上の引用
  let multi = 0;
  const byConv = new Map<string, typeof rows>();
  for (const r of rows) { const a = byConv.get(r.conversation_id) ?? []; a.push(r); byConv.set(r.conversation_id, a); }
  for (const a of byConv.values()) for (let i = 1; i < a.length; i++) if (Date.parse(a[i].created_at) - Date.parse(a[i - 1].created_at) < 10 * 60_000 && a[i].quoted_message_id !== a[i - 1].quoted_message_id) multi++;
  console.log(`直近${days}日の引用返信 ${c.total}通`);
  console.log(`  引用先が見つからない ${c.missing}／文 ${c.text}／お客様の画像 ${c.custImage}／こちらの画像 ${c.staffImage}`);
  console.log(`  こちらの画像: サムネイル ${c.staffImageThumb}／物件名 ${c.staffImageLabel}／保存切れ ${c.staffImageGone}`);
  console.log(`  10分以内に別の物を続けて引用（今までは最後の1通だけが生成・AIX に渡っていた）: ${multi}組`);
  console.log(samples.join("\n"));
})();
