// scripts/audit-star-bundle-link.ts
// 🌟の記録が「新着1件」か「束の中の🌟」かを、過去の記録でも同じ関数（star-bundle.starBundleOf）で結ぶ（読むだけ・LLM なし・費用0・DB に書かない）。
//   2026-10-06 竹内さん「なおす」（「新着1件」とされた🌟の記録の 57% は実は束の中の🌟・候補が記録されていない）
//   1. 候補1件以下の🌟（今の isNewArrivalSnapshot で新着1件になる物）を 束／新着1件／分からない に分ける（月ごと・live/backfill）
//   2. 束のうち、売上サポの回（property_pickups）に結べた数・グループに届いた行（sent_properties delivery=shared）に結べた数
//   3. 例を目で読む（束と決めた理由・スタッフの画像の数・結べた回）
//   ※ 本番の記録（recordRecommendationSnapshot）は 10/06 から star_kind・bundle の列に同じ物を残す（列は migrate-schema・本番への ALTER は承認待ち）
// 実行: npx tsx --env-file=.env.local scripts/audit-star-bundle-link.ts [--days=400] [--show=15]
import { createClient } from "@supabase/supabase-js";
import { starBundleOf, type StarBundle } from "../app/lib/star-bundle";
import { isNewArrivalSnapshot } from "../app/lib/hooked-arrival-learning";
import { isCustomerRow } from "../app/lib/sent-delivery";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "400"), 10);
const SHOW = parseInt(String(args.show ?? "15"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
type Row = Record<string, any>;
const D = 864e5, H = 36e5;
const P = (...x: unknown[]) => console.log(...x);
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "-");
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 300): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 200; p++) { const { data, error } = await build(p * page, p * page + page - 1); if (error) throw new Error(error.message); if (!data?.length) break; out = out.concat(data); if (data.length < page) break; }
  return out;
}
async function pmap<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> { const out: R[] = new Array(xs.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } })); return out; }

(async () => {
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, star_text, candidate_count, candidates, source")
    .gte("sent_at", new Date(Date.now() - DAYS * D).toISOString()).order("id").range(a, b) as never)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && s.star_name);
  const target = snaps.filter((s) => isNewArrivalSnapshot(s));
  P(`=== 🌟の記録 ${snaps.length}（${DAYS}日）・今の見分けで新着1件 ${target.length}（候補1件以下 ${target.filter((s) => (s.candidate_count ?? 0) < 2).length}）===`);
  const res = await pmap(target, 6, async (s) => {
    const t = Date.parse(s.sent_at);
    const { data: msgs, error: me } = await sb.from("messages").select("sender, image_url, text, created_at").eq("conversation_id", s.conversation_id)
      .gte("created_at", new Date(t - 30 * 60_000).toISOString()).lte("created_at", new Date(t + 5 * 60_000).toISOString()).order("created_at").limit(200);
    const pc = s.property_customer_id ? String(s.property_customer_id) : null;
    const pickups = pc ? (((await sb.from("property_pickups").select("id, batch_id, created_at, property_name, room_no, status, complete_group_id").eq("property_customer_id", pc)
      .gte("created_at", new Date(t - 72 * H).toISOString()).lte("created_at", new Date(t + 60_000).toISOString()).limit(300)).data ?? []) as Row[]) : [];
    const spQ = sb.from("sent_properties").select("property_name, room_no, sent_at, delivery, source, pickup_id").gte("sent_at", new Date(t - 72 * H).toISOString()).lte("sent_at", new Date(t + 60_000).toISOString()).limit(300);
    const sp = ((await (pc ? spQ.or(`conversation_id.eq.${s.conversation_id},property_customer_id.eq.${pc}`) : spQ.eq("conversation_id", s.conversation_id))).data ?? []) as Row[];
    const cands = ((typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) ?? []) as Row[];
    const b: StarBundle = starBundleOf({
      sentAt: s.sent_at, starName: String(s.star_name), starRoom: s.star_room ?? null, starText: s.star_text ?? null,
      msgs: me ? null : (msgs ?? []) as never, customerSentAt: cands.filter((c) => c.source !== "star_text").map((c) => c.sent_at ?? null),
      pickups: pickups.map((p) => ({ id: Number(p.id), batch_id: String(p.batch_id), created_at: String(p.created_at), property_name: p.property_name, room_no: p.room_no, status: p.status, complete_group_id: p.complete_group_id ?? null })),
      shared: sp.filter((r) => !isCustomerRow(r as never)).map((r) => ({ property_name: r.property_name, room_no: r.room_no, sent_at: r.sent_at, pickup_id: r.pickup_id ?? null })),
    });
    return { s, b };
  });
  const by = (f: (x: (typeof res)[number]) => string) => { const m: Record<string, number> = {}; for (const x of res) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return Object.entries(m).sort().map(([k, v]) => `${k} ${v}`).join("・"); };
  const bundles = res.filter((x) => x.b.kind === "bundle");
  P(`\n1. 見分け: ${by((x) => x.b.kind)}（束 ${pct(bundles.length, res.length)}）`);
  P(`   月ごと（束/全部）: ${[...new Set(res.map((x) => x.s.sent_at.slice(0, 7)))].sort().map((m) => `${m} ${res.filter((x) => x.s.sent_at.startsWith(m) && x.b.kind === "bundle").length}/${res.filter((x) => x.s.sent_at.startsWith(m)).length}`).join("・")}`);
  P(`   live/backfill（束/全部）: ${["live", "backfill"].map((k) => `${k} ${res.filter((x) => x.s.source === k && x.b.kind === "bundle").length}/${res.filter((x) => x.s.source === k).length}`).join("・")}`);
  P(`   束と決めた理由: ${by((x) => x.b.kind === "bundle" ? x.b.why.join("+") : "-")}`);
  P(`\n2. 束 ${bundles.length} のうち: 売上サポの回に結べた ${bundles.filter((x) => x.b.pickup_batch_id).length}（🌟の行まで ${bundles.filter((x) => x.b.star_pickup_id != null).length}）・グループに届いた行がある ${bundles.filter((x) => x.b.group_rows.length).length}・どちらも無い ${bundles.filter((x) => !x.b.pickup_batch_id && !x.b.group_rows.length).length}`);
  P(`   束の候補の行の数（売上サポの回に結べた物）: ${bundles.filter((x) => x.b.pickup_batch_id).map((x) => x.b.pickup_ids.length).join(",")}`);
  P(`   9/24（売上サポの記録の始まり）以降の束 ${bundles.filter((x) => x.s.sent_at >= "2026-09-24").length}: 売上サポの回 ${bundles.filter((x) => x.s.sent_at >= "2026-09-24" && x.b.pickup_batch_id).length}・グループの行 ${bundles.filter((x) => x.s.sent_at >= "2026-09-24" && x.b.group_rows.length).length}`);
  P(`   新着1件（single）${res.filter((x) => x.b.kind === "single").length} のうち売上サポの回がある ${res.filter((x) => x.b.kind === "single" && x.b.pickup_batch_id).length}（新着の回を売上サポで作った物）`);
  P(`\n3. 例（束）:`);
  for (const x of bundles.slice(-SHOW)) P(`  #${x.s.id} ${x.s.sent_at.slice(0, 16)} ${x.s.source} 🌟${x.s.star_name} 画像${x.b.staff_images}・${x.b.why.join("+")}・回 ${x.b.pickup_batch_id ? `${x.b.pickup_ids.length}行${x.b.star_pickup_id != null ? "（🌟あり）" : ""}` : "-"}・グループ ${x.b.group_rows.length}行（${x.b.group_rows.slice(0, 3).map((g) => g.name).join("／")}）`);
  P(`   例（新着1件）:`);
  for (const x of res.filter((y) => y.b.kind === "single").slice(-5)) P(`  #${x.s.id} ${x.s.sent_at.slice(0, 16)} 🌟${x.s.star_name} 画像${x.b.staff_images}`);
})().catch((e) => { console.error(e); process.exit(1); });
