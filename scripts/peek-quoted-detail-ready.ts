// 引用された画像のうち、今なら中身が分かる物は何割か（読み取りのみ）
// 2026-09-21 竹内「引用先の画像を読み取れるように」— 入れた後の確認
// 実行: npx tsx --env-file=.env.local scripts/peek-quoted-detail-ready.ts [--days=30]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data: q } = await sb.from("messages")
    .select("text, quoted_message_id, conversation_id, created_at")
    .eq("sender", "customer").not("quoted_message_id", "is", null).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(300);
  const quoting = (q ?? []) as Array<{ text: string | null; quoted_message_id: string; conversation_id: string; created_at: string }>;
  const ids = [...new Set(quoting.map((m) => m.quoted_message_id))];
  const targets = new Map<string, { sender: string; text: string | null; image_url: string | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from("messages").select("line_message_id, sender, text, image_url").in("line_message_id", ids.slice(i, i + 100));
    for (const r of (data ?? []) as Array<{ line_message_id: string; sender: string; text: string | null; image_url: string | null }>) targets.set(r.line_message_id, r);
  }
  const imgs = quoting.filter((m) => { const t = targets.get(m.quoted_message_id); return t?.sender === "staff" && !!t.image_url; });
  const urls = [...new Set(imgs.map((m) => targets.get(m.quoted_message_id)!.image_url!))];
  const detail = new Map<string, { kind: string; lines: string[] }>();
  for (let i = 0; i < urls.length; i += 20) {
    const { data, error } = await sb.from("image_details").select("image_url, kind, lines").in("image_url", urls.slice(i, i + 20));
    if (error) { console.log("⚠", error.message); break; }
    for (const r of (data ?? []) as Array<{ image_url: string; kind: string; lines: unknown }>) {
      detail.set(r.image_url, { kind: r.kind, lines: Array.isArray(r.lines) ? (r.lines as unknown[]).map(String) : [] });
    }
  }
  let prop = 0, est = 0, none = 0;
  for (const u of urls) {
    const d = detail.get(u);
    if (!d) { none++; continue; }
    if (d.kind === "property" && d.lines.length > 0) prop++; else est++;
  }
  console.log(`=== 直近${DAYS}日 こちらが送った画像への引用 ${imgs.length}件（画像 ${urls.length}枚）===`);
  console.log(`  中身が分かる（物件資料）: ${prop}`);
  console.log(`  見積書など中身を読まない : ${est}`);
  console.log(`  まだ読んでいない        : ${none}`);
  console.log(`\n── 直近5件 ──`);
  for (const m of imgs.slice(0, 5)) {
    const u = targets.get(m.quoted_message_id)!.image_url!;
    const d = detail.get(u);
    console.log(`${m.created_at.slice(0, 16)} 客「${mask(String(m.text ?? "")).replace(/\n/g, " ").slice(0, 40)}」`);
    console.log(`   → ${d ? `${d.kind} ${d.lines.slice(0, 5).join(" ／ ")}` : "まだ読んでいない"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
