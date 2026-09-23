// 送付記録（sent_properties・line_group）に「送った時の AD」を埋め戻す。
// 出所: 同じお客様の候補プール（property_candidate_pools・拡張が検索した時の表の文字）で、送付の2日前〜10分後に同名の候補があれば ad_months。
// 2026-09-24 竹内「物件オススメ・ピックアップで送った物件なら AD も理解しているはず」。これからの送付は merge-pdfs が説明文から書く。
// 実行: npx tsx --env-file=.env.local scripts/backfill-sent-properties-ad.ts [--days=180] [--dry-run]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "180"));
const DRY = process.argv.includes("--dry-run");
const norm = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/\s/g, "");

type Sent = { id: string; property_customer_id: string; property_name: string | null; rent: number | null; sent_at: string; ad_months: number | null };
type Pool = { property_customer_id: string; sent_at: string; candidates: Array<{ name?: string; ad_months?: number | null; rent?: number | null }> | null };

async function page<T>(table: string, cols: string, build: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(cols)).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const sent = await page<Sent>("sent_properties", "id, property_customer_id, property_name, rent, sent_at, ad_months",
    (q) => q.eq("source", "line_group").not("property_customer_id", "is", null).is("ad_months", null).gte("sent_at", since).order("sent_at", { ascending: false }));
  const pools = await page<Pool>("property_candidate_pools", "property_customer_id, sent_at, candidates",
    (q) => q.gte("sent_at", new Date(new Date(since).getTime() - 2 * 86400_000).toISOString()).order("sent_at", { ascending: false }));
  const byCust = new Map<string, Pool[]>();
  for (const p of pools) { const a = byCust.get(p.property_customer_id) ?? []; a.push(p); byCust.set(p.property_customer_id, a); }
  console.log(`=== sent_properties（AD 未設定・${DAYS}日）${sent.length}件 × 候補プール ${pools.length}件 ${DRY ? "・下見だけ" : ""} ===`);
  let matched = 0, withAd = 0, written = 0;
  const updates: Array<{ id: string; ad_months: number; ad_yen: number | null }> = [];
  for (const s of sent) {
    const t = new Date(s.sent_at).getTime();
    const cands = (byCust.get(s.property_customer_id) ?? [])
      .filter((p) => { const pt = new Date(p.sent_at).getTime(); return pt >= t - 2 * 86400_000 && pt <= t + 10 * 60_000; })
      .flatMap((p) => p.candidates ?? []);
    const hit = cands.find((c) => norm(c.name) === norm(s.property_name));
    if (!hit) continue;
    matched++;
    const ad = hit.ad_months != null && hit.ad_months > 0 && hit.ad_months <= 12 ? Number(hit.ad_months) : null;
    if (ad == null) continue;
    withAd++;
    const rent = s.rent ?? (hit.rent && hit.rent > 0 ? hit.rent : null);
    updates.push({ id: s.id, ad_months: ad, ad_yen: rent ? Math.round(ad * rent) : null });
  }
  if (!DRY) {
    for (const u of updates) {
      const { error } = await sb.from("sent_properties").update({ ad_months: u.ad_months, ad_yen: u.ad_yen }).eq("id", u.id);
      if (!error) written++;
    }
  }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  console.log(`候補プールに同名 ${matched}（${pct(matched, sent.length)}）／AD あり ${withAd}（${pct(withAd, sent.length)}）／AD 円まで出た ${updates.filter((u) => u.ad_yen != null).length}／書いた ${written}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
