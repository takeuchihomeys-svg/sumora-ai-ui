// scripts/audit-meeting-address.ts
// 2026-10-01 竹内（YUMA「住所: 大阪府大阪市北区天満3丁目」）: 待ち合わせ場所の住所の関所（app/lib/meeting-address.ts）を過去に当てる（読むだけ・書き込みなし・LLM なし）
//   1) スタッフの実送信（「住所:」を含む・テスト用の会話を除く）→ 番地ありを誤って止める数（目標 0）と、止まる物の実物
//   2) 物件資料（property_pickups.pdf_text の所在地）→ 番地なしの資料の数と実物（補いの材料になるか）
//   3) 番地の書き方の内訳（1-27／1丁目27番／1番27号 …）
// 実行: npx tsx --env-file=.env.local scripts/audit-meeting-address.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { hasBanchi, addressLineInText, materialAddressFromPdfText } from "../app/lib/meeting-address";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function styleOf(a: string): string {
  const s = a.normalize("NFKC");
  if (/\d+番\d+号/.test(s)) return "◯番◯号";
  if (/\d+番地?\d*/.test(s)) return "◯番（◯）";
  if (/丁目?\s*\d+-\d+/.test(s)) return "◯丁目◯-◯";
  if (/\d+-\d+-\d+/.test(s)) return "◯-◯-◯";
  if (/\d+-\d+/.test(s)) return "◯-◯";
  if (/\d+号/.test(s)) return "◯号";
  return "その他";
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  type M = { id: string; conversation_id: string; created_at: string; text: string };
  const msgs = await pageAll<M>((f, t) => sb.from("messages").select("id,conversation_id,created_at,text")
    .eq("sender", "staff").like("text", "%住所%").gte("created_at", since).order("created_at").range(f, t));
  const rows = msgs.filter((m) => !isTestConversation(m.conversation_id) && /住所[:：]/.test(m.text ?? ""));
  const meeting = rows.filter((m) => /待ち合わせ/.test(m.text));
  let blocked = 0; const styles = new Map<string, number>();
  console.log(`\n== 1) スタッフの実送信（直近${DAYS}日・「住所:」あり・テスト用の会話を除く）: ${rows.length}通（うち待ち合わせ ${meeting.length}通）`);
  for (const m of rows) {
    const a = addressLineInText(m.text);
    const ok = hasBanchi(a);
    if (!ok) { blocked++; console.log(`  ✗ 止まる: ${m.created_at.slice(0, 16)} ${m.conversation_id.slice(0, 8)} 「${a}」 待ち合わせ=${/待ち合わせ/.test(m.text)}`); }
    else styles.set(styleOf(a), (styles.get(styleOf(a)) ?? 0) + 1);
  }
  const blockedMeeting = meeting.filter((m) => !hasBanchi(addressLineInText(m.text))).length;
  console.log(`  番地あり ${rows.length - blocked} / 止まる ${blocked}（待ち合わせの送信で止まる ${blockedMeeting}）`);
  console.log(`  「丁目」「町」で終わる: ${rows.filter((m) => /(丁目|町)\s*$/.test(addressLineInText(m.text).normalize("NFKC"))).length}`);
  console.log("  書き方:", Object.fromEntries([...styles.entries()].sort((a, b) => b[1] - a[1])));

  type P = { id: number; site: string; property_name: string; pdf_text: string | null };
  const pk = await pageAll<P>((f, t) => sb.from("property_pickups").select("id,site,property_name,pdf_text").like("pdf_text", "%所在地%").order("id").range(f, t));
  const bySite = new Map<string, { n: number; ok: number; empty: number; ng: string[] }>();
  for (const p of pk) {
    const a = materialAddressFromPdfText(p.pdf_text);
    const s = bySite.get(p.site) ?? { n: 0, ok: 0, empty: 0, ng: [] };
    s.n++;
    if (!a) s.empty++;
    else if (hasBanchi(a)) s.ok++;
    else s.ng.push(`${p.id} ${p.property_name}「${a}」`);
    bySite.set(p.site, s);
  }
  console.log(`\n== 2) 物件資料の所在地（property_pickups・${pk.length}行）`);
  for (const [site, s] of bySite) {
    console.log(`  ${site}: ${s.n}行 番地あり ${s.ok} / 番地なし ${s.ng.length} / 取れない ${s.empty}`);
    for (const x of s.ng) console.log(`    - ${x}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
