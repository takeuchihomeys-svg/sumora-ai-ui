// scripts/audit-pickup-owner.ts — 物件の候補（property_pickups）の付け先が、その時に検索していた回のお客様か（読むだけ）
// 2026-09-30 竹内「監視のところでちゃんと入り込まんように対策する／お客さんの名前ずれてないか監視する」
//   拡張 v2.5.47 までの自動便で、ITANDI の物件が前のお客様に付いた（9/30 16:39〜19:02・161件）。その時に使った突き合わせを道具にした物。
//   束（batch_id×付け先）が届いた時刻に、同じサイトで走っていた検索の回（search_audits）のお客様を並べ、付け先がその中に居なければ「ずれの疑い」。
//   ・点検の行の created_at は拡張の PC の時計で1〜2分ずれる事があるので、回の窓は 前90秒〜終わりの後180秒 に広げる
//   ・その時に走っていた回が1つも無い束（手の検索・スタッフ・点検の無い版）は「分からない」（疑いにしない）
//   ・名前ずれ: 束の customer_name と、付け先の property_customers.customer_name が違う束も出す
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-owner.ts [--days=7] [--site=itandi|realpro]
import { createClient } from "@supabase/supabase-js";
import { normCustomerName } from "../app/lib/pickup-owner";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "7")) || 7;
const SITE = arg("site");
const BEFORE_MS = 90_000, AFTER_MS = 180_000;
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 19).replace("T", " ");

type Pickup = { id: number; created_at: string; batch_id: string | null; property_customer_id: string | null; customer_name: string | null; site: string | null; status: string | null; sent_at: string | null };
type Audit = { property_customer_id: string | null; site: string | null; created_at: string; finished_at: string | null; trigger: string | null; ext_version: string | null };

async function all<T>(table: string, cols: string, since: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).gte("created_at", since).order("created_at").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const pickups = (await all<Pickup>("property_pickups", "id, created_at, batch_id, property_customer_id, customer_name, site, status, sent_at", since)).filter((p) => !SITE || p.site === SITE);
  const audits = (await all<Audit>("search_audits", "property_customer_id, site, created_at, finished_at, trigger, ext_version", new Date(Date.parse(since) - 3600_000).toISOString())).filter((a) => a.trigger !== "single");
  const { data: pcs } = await sb.from("property_customers").select("id, customer_name").limit(5000);
  const nameOf = new Map(((pcs ?? []) as Array<{ id: string; customer_name: string | null }>).map((c) => [c.id, c.customer_name]));

  const groups = new Map<string, Pickup[]>();
  for (const p of pickups) {
    const k = `${p.batch_id}|${p.property_customer_id}|${p.site}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }
  let okN = 0, unknownN = 0;
  const suspects: string[] = [], nameDrifts: string[] = [];
  for (const rows of groups.values()) {
    const p0 = rows[0];
    const t0 = Math.min(...rows.map((r) => Date.parse(r.created_at)));
    const running = audits.filter((a) => a.site === p0.site && Date.parse(a.created_at) - BEFORE_MS <= t0 && (a.finished_at ? Date.parse(a.finished_at) : Date.parse(a.created_at) + 20 * 60_000) + AFTER_MS >= t0);
    const owners = [...new Set(running.map((a) => a.property_customer_id).filter(Boolean))] as string[];
    const ids = `${Math.min(...rows.map((r) => r.id))}〜${Math.max(...rows.map((r) => r.id))}`;
    const sent = rows.filter((r) => r.sent_at || r.status === "sent").length;
    const head = `${jst(new Date(t0).toISOString())} ${p0.site} id ${ids}（${rows.length}件・送信済み ${sent}）付け先 ${String(p0.property_customer_id).slice(0, 8)}`;
    if (!owners.length) unknownN++;
    else if (p0.property_customer_id && owners.includes(p0.property_customer_id)) okN++;
    else suspects.push(`${head} ／ その時の回 ${running.map((a) => `${String(a.property_customer_id).slice(0, 8)}(${a.trigger}・${a.ext_version ?? "?"})`).join(", ")}`);
    const db = p0.property_customer_id ? nameOf.get(p0.property_customer_id) : null;
    if (db && p0.customer_name && normCustomerName(db) !== normCustomerName(p0.customer_name)) nameDrifts.push(`${head} ／ 束の名前と登録の名前が違う`);
  }
  console.log(`直近${DAYS}日${SITE ? `・${SITE}` : ""}: 束 ${groups.size}（本人の回 ${okN}・ずれの疑い ${suspects.length}・分からない ${unknownN}）／名前ずれ ${nameDrifts.length}`);
  if (suspects.length) { console.log("\n■ ずれの疑い（付け先が、その時に検索していた回のお客様の中に居ない）"); for (const s of suspects) console.log("  " + s); }
  if (nameDrifts.length) { console.log("\n■ 名前ずれ"); for (const s of nameDrifts) console.log("  " + s); }
}
main().catch((e) => { console.error(e); process.exit(1); });
