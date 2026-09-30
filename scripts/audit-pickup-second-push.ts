// scripts/audit-pickup-second-push.ts — AIX【物件ピックアップ】（複数の資料を送った通）の直後の2通目で、スタッフは「どの物件」を推しているか（読むだけ）
//
// 2026-10-01 竹内さん了承「実送信の形に合わせる」(b): 物件ピックアップ（複数）の後の2通目も、物件オススメの2通目と同じ形
//   （「お送りさせて頂きましたお部屋の中でも特に◯◯ 号室が〜、◯◯さんにかなりオススメ出来るお部屋となります！！」＋締め）に広げる。
//   どの物件を推すか（送った画像の並び・AD・家賃）を実送信から決める。
//
// 組の作り方: スタッフの画像（2枚以上・送った物件が sent_properties / sent_image_properties で読める）→ 10分以内のピックアップの文（🌟で始まらない）
//   → 間にお客様の発言なしで 15分以内に続けて送った2通目（「中でも特に」「かなりオススメ」を含む）。YUMA は除く。
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-second-push.ts [--days=365] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365")) || 365;
const SHOW = Number(arg("show", "10"));
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const norm = (s: string) => s.normalize("NFKC").replace(/[\s　・･]/g, "").toLowerCase();

type M = { conversation_id: string; sender: string; text: string | null; created_at: string; image_url: string | null };
type SP = { conversation_id: string; image_url: string | null; property_name: string | null; room_no: string | null; ad_months: number | null; rent: number | null };

async function all<T>(build: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const rows = await all<M>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, image_url").gte("created_at", since).order("conversation_id").order("created_at").range(a, b));
  const sps = await all<SP>((a, b) => sb.from("sent_properties").select("conversation_id, image_url, property_name, room_no, ad_months, rent").gte("sent_at", since).not("image_url", "is", null).range(a, b));
  const sip = await all<SP>((a, b) => sb.from("sent_image_properties").select("conversation_id, image_url, property_name, room_no").gte("created_at", since).range(a, b));
  const byImg = new Map<string, SP>();
  for (const r of [...sip, ...sps]) if (r.image_url && r.property_name) byImg.set(r.image_url, { ...(byImg.get(r.image_url) ?? {}), ...r });

  type Case = { conv: string; at: string; second: string; props: Array<SP & { pos: number }>; hit: number };
  const cases: Case[] = [];
  const byConv = new Map<string, M[]>();
  for (const r of rows) { if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []); byConv.get(r.conversation_id)!.push(r); }
  for (const [conv, ms] of byConv) {
    if (isTestConversation(conv)) continue;
    for (let i = 0; i < ms.length; i++) {
      const a = ms[i];
      if (a.sender !== "staff" || !a.text || /^\s*🌟/.test(a.text) || !/ピックアップ|募集に(?:出|で)ました|お送りさせて/.test(a.text) || /^\[/.test(a.text)) continue;
      const at = Date.parse(a.created_at);
      // 直前 10分のスタッフの画像（お客様の発言が挟まれば止める）
      const imgs: M[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const m = ms[j];
        if (m.sender !== "staff" || at - Date.parse(m.created_at) > 10 * 60_000) break;
        if (m.image_url) imgs.unshift(m);
      }
      if (imgs.length < 2) continue;
      let b: M | null = null;
      for (let j = i + 1; j < ms.length; j++) {
        const n = ms[j];
        if (n.sender !== "staff" || Date.parse(n.created_at) - at > 15 * 60_000) break;
        if (!n.text || /^\[/.test(n.text)) continue;
        b = n; break;
      }
      if (!b || !/中でも特に|中でも|かなりオススメ|特にオススメ/.test(b.text!)) continue;
      const props = imgs.map((m, k) => ({ ...(byImg.get(m.image_url!) ?? { conversation_id: conv, image_url: m.image_url, property_name: null, room_no: null, ad_months: null, rent: null }), pos: k }));
      const known = props.filter((p) => p.property_name);
      if (known.length < 2) continue;
      const t = norm(b.text!);
      const hits = known.filter((p) => t.includes(norm(p.property_name!).slice(0, 6)));
      if (hits.length !== 1) continue;
      cases.push({ conv, at: b.created_at, second: b.text!, props, hit: hits[0].pos });
    }
  }
  console.log(`直近${DAYS}日: ピックアップ（画像2枚以上・物件が読める）→ 2通目で1件を推した ${cases.length}組\n`);
  const n = cases.length;
  const first = cases.filter((c) => c.hit === 0).length;
  const last = cases.filter((c) => c.hit === c.props.length - 1).length;
  console.log(`推した物件の位置: 1枚目 ${first}（${pct(first, n)}）・最後 ${last}（${pct(last, n)}）・それ以外 ${n - first - last}（${pct(n - first - last, n)}）`);
  const withAd = cases.filter((c) => c.props.filter((p) => typeof p.ad_months === "number").length >= 2);
  const adTop = withAd.filter((c) => { const ads = c.props.map((p) => p.ad_months ?? -1); return (c.props[c.hit].ad_months ?? -1) === Math.max(...ads); }).length;
  console.log(`AD が2件以上読める ${withAd.length}組: 推したのが AD 最大 ${adTop}（${pct(adTop, withAd.length)}）`);
  const withRent = cases.filter((c) => c.props.filter((p) => typeof p.rent === "number" && p.rent > 0).length >= 2);
  const rentLow = withRent.filter((c) => { const rs = c.props.map((p) => (p.rent && p.rent > 0 ? p.rent : Infinity)); return (c.props[c.hit].rent ?? Infinity) === Math.min(...rs); }).length;
  console.log(`家賃が2件以上読める ${withRent.length}組: 推したのが家賃最安 ${rentLow}（${pct(rentLow, withRent.length)}）`);
  const cnt = new Map<number, number>(); for (const c of cases) cnt.set(c.props.length, (cnt.get(c.props.length) ?? 0) + 1);
  console.log(`送った枚数: ${[...cnt].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}枚 ${v}`).join("・")}`);
  for (const c of cases.slice(-SHOW)) console.log(`  [${c.at.slice(0, 10)}] ${c.props.length}枚中 ${c.hit + 1}枚目（${c.props.map((p) => `${p.property_name ?? "?"}${p.ad_months != null ? `/AD${p.ad_months}` : ""}`).join("｜")}） → ${c.second.replace(/\n+/g, " ⏎ ").slice(0, 150)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
