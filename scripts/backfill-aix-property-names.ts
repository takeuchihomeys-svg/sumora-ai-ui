// 過去の AIX の送信の記録（aix_usage_logs.property_names が空の行）に物件名（号室まで）を埋める。
// 2026-10-08 8巡目（記録の続き・竹内「オススメした物件と、お客さんが送ってきた物件をちゃんと保管できていればできる」）
//   出所: 物件オススメ＝本文の🌟の行 → 無ければ recommendation_snapshots（star_name・star_room）／見積書・内覧調整・待ち合わせ＝本文
//         （app/lib/aix-sent-names.aixPropertyNamesForLog）／物件送付＝送信の前後（5分前〜3分後）の sent_properties（namesNearSend）
//   既定は下見だけ（書かない）。書く時は --apply（名前がまだ無い行だけ・property_names IS NULL の条件つきで1行ずつ）。
// 実行: npx tsx --env-file=.env.local scripts/backfill-aix-property-names.ts [--days=30] [--apply]
import { createClient } from "@supabase/supabase-js";
import { aixPropertyNamesForLog, namesNearSend } from "../app/lib/aix-sent-names";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "30"));
const APPLY = process.argv.includes("--apply");
const TYPES = ["property_recommendation", "property_send", "estimate_sheet", "viewing_invite", "meeting_place", "property_check_result"];
const GROUP_OR_TEST = new Set(["dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"]);

type Log = { id: string; conversation_id: string; aix_type: string; created_at: string; sent_at: string | null; generated_text: string | null; property_names: string[] | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const logs: Log[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("aix_usage_logs").select("id, conversation_id, aix_type, created_at, sent_at, generated_text, property_names")
      .gte("created_at", since).in("aix_type", TYPES).not("sent_at", "is", null).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw error;
    logs.push(...((data ?? []) as Log[]));
    if ((data ?? []).length < 1000) break;
  }
  const real = logs.filter((l) => !GROUP_OR_TEST.has(l.conversation_id));
  const recIds = real.filter((l) => l.aix_type === "property_recommendation").map((l) => l.id);
  const snaps = new Map<string, { star_name: string | null; star_room: string | null }>();
  for (let i = 0; i < recIds.length; i += 200) {
    const { data } = await sb.from("recommendation_snapshots").select("aix_usage_log_id, star_name, star_room").in("aix_usage_log_id", recIds.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ aix_usage_log_id: string; star_name: string | null; star_room: string | null }>) snaps.set(r.aix_usage_log_id, r);
  }
  const stat: Record<string, { n: number; before: number; after: number; from: Record<string, number> }> = {};
  const plan: Array<{ id: string; names: string[] }> = [];
  for (const l of real) {
    const s = (stat[l.aix_type] ??= { n: 0, before: 0, after: 0, from: {} });
    s.n++;
    if (l.property_names?.length) { s.before++; s.after++; continue; }
    let names = aixPropertyNamesForLog({ aixType: l.aix_type, text: l.generated_text });
    let from = "text";
    if (!names.length && l.aix_type === "property_recommendation") {
      const sn = snaps.get(l.id);
      if (sn?.star_name) { names = [sn.star_room ? `${sn.star_name} ${sn.star_room}号室` : sn.star_name]; from = "snapshot"; }
    }
    if (!names.length && l.aix_type === "property_send" && l.sent_at) {
      const t = Date.parse(l.sent_at);
      const { data } = await sb.from("sent_properties").select("property_name, room_no, sent_at, delivery").eq("conversation_id", l.conversation_id)
        .gte("sent_at", new Date(t - 5 * 60_000).toISOString()).lte("sent_at", new Date(t + 3 * 60_000).toISOString()).limit(60);
      names = namesNearSend((data ?? []) as Array<{ property_name: string | null; room_no: string | null; sent_at: string | null; delivery: string | null }>, l.sent_at);
      from = "sent_properties";
    }
    if (!names.length) continue;
    s.after++; s.from[from] = (s.from[from] ?? 0) + 1;
    plan.push({ id: l.id, names: names.map((n) => n.slice(0, 100)) });
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  console.log(`=== AIX の送信 ${real.length}通（${DAYS}日・YUMA を除く）${APPLY ? "・書く" : "・下見だけ（書かない）"} ===`);
  for (const [t, s] of Object.entries(stat)) console.log(`${t}: 物件名あり 前 ${s.before}/${s.n}（${pct(s.before, s.n)}）→ 後 ${s.after}/${s.n}（${pct(s.after, s.n)}）出所 ${JSON.stringify(s.from)}`);
  console.log(`埋める行 ${plan.length}`);
  if (!APPLY) return;
  let ok = 0;
  for (const p of plan) {
    const { error } = await sb.from("aix_usage_logs").update({ property_names: p.names }).eq("id", p.id).is("property_names", null);
    if (!error) ok++; else console.warn(p.id.slice(0, 8), error.message);
  }
  console.log(`書いた ${ok}/${plan.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
