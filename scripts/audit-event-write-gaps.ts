// scripts/audit-event-write-gaps.ts — 番が来た時だけ書く記録の「来た番 → 書いた数」（読むだけ・LLM なし・費用0・軽い読み）
//
// 2026-11-22 作業員K2（統括役: カウンターキッチンの画像の読みが14日で0行・刺さった点が0行の原因を分ける・#479）。
//   どちらも毎日書く数ではなく、番が来た時だけ書く記録。0行が「番が来ていない」のか「来たのに書いていない（作ったのに回っていない）」のかを毎日分ける。
//   ① カウンターキッチンの画像の読み（COUNTER_KITCHEN_IMAGE_READ・作業員G・property-pickups-server）:
//      来た番＝property_pickups の equipment.match に counter_kitchen が unlisted で入った行（お客様の希望あり×資料の文字では分からない）
//      書いた数＝そのうち image_facts.counter_kitchen を持つ行
//      ※ 画像の URL が無い行・1回に読む上限（IMAGE_READ_MAX_PER_BATCH）の外の行は読まないので、来た番より書いた数が少ないことはある
//   ② 刺さった点（SENT_HOOK_POINTS・line-webhook-text resolvePropertyReference）:
//      来た番＝お客様が物件の通を引用して返し、送った物件に結び付いた返事（messages.referenced_property_id）
//      書いた数＝sent_properties.customer_hook_points が付いた行。返事が刺さった点を言わない（「内覧したいです」等）時は書かないのが正しい＝
//      30日の結び付いた返事 28通に hookPointsOf を当てると、点が出るのは 1通（11/22 の照らし）。率が低いのは形どおり
// 11/22 の結果: ① 30日で来た番 16行（最後は 11/16）・on（11/21 15:55）の後は来た番 0 ＝ 番が来ていない
//               ② on（11/21 12:14）の後の引用の返事 4通は、どれも物件の通の引用ではなかった ＝ 番が来ていない
// 実行: npx tsx --env-file=.env.local scripts/audit-event-write-gaps.ts [--days=7] [--json | --json=<道>]
//   --json: 1行の {days, ck:{came, wrote}, hook:{came, wrote}}（毎朝の1枚の growth:event_write:ck_came／ck_wrote／hook_came／hook_wrote）
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
/** 既定 on にした時刻（main に入った時刻・これより前の番は数えない＝on の前の番で ⚠ を出さない） */
const CK_ON_AT = "2026-11-21T06:55:00Z"; // 055dffadf COUNTER_KITCHEN_IMAGE_READ 既定 on
const HOOK_ON_AT = "2026-11-21T03:14:00Z"; // e3d5199c4 SENT_HOOK_POINTS 既定 on
const later = (a: string, b: string) => (Date.parse(a) > Date.parse(b) ? a : b);
type Eq = { match?: Array<{ key?: string; result?: string }> } | null;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "7")) || 7;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: pk, error } = await sb.from("property_pickups").select("equipment, image_facts").gte("created_at", later(since, CK_ON_AT)).limit(5000);
  if (error) throw new Error(error.message);
  let ckCame = 0, ckWrote = 0;
  for (const r of (pk ?? []) as Array<{ equipment: Eq; image_facts: Record<string, unknown> | null }>) {
    if (!(r.equipment?.match ?? []).some((m) => m.key === "counter_kitchen" && m.result === "unlisted")) continue;
    ckCame++;
    if (r.image_facts && typeof r.image_facts === "object" && "counter_kitchen" in r.image_facts) ckWrote++;
  }
  const { count: hookCame } = await sb.from("messages").select("id", { count: "exact", head: true }).not("referenced_property_id", "is", null).gte("created_at", later(since, HOOK_ON_AT));
  // 刺さった点は sent_properties に日時の列（書いた時）が無い＝送った日が窓より前の行もある。送った物件を 30日 前まで見る
  const { count: hookWrote } = await sb.from("sent_properties").select("id", { count: "exact", head: true }).not("customer_hook_points", "is", null).gte("sent_at", new Date(Date.now() - (days + 30) * 864e5).toISOString());
  const out = { days, ck: { came: ckCame, wrote: ckWrote }, hook: { came: hookCame ?? 0, wrote: hookWrote ?? 0 } };
  const jsonArg = process.argv.find((a) => a === "--json" || a.startsWith("--json="));
  if (jsonArg === "--json") { console.log(JSON.stringify(out)); return; }
  if (jsonArg) writeFileSync(jsonArg.slice(7), JSON.stringify(out, null, 2));
  console.log(`番が来た時だけ書く記録（${days}日）: カウンターキッチンの画像の読み 来た番 ${ckCame}・書いた ${ckWrote}／刺さった点 物件に結び付いた引用の返事 ${out.hook.came}・点を書いた送った物件 ${out.hook.wrote}`);
  if (ckCame > 0 && ckWrote === 0) console.log("  ⚠ カウンターキッチン: 番が来たのに1行も書いていない（作ったのに回っていない疑い）");
})().catch((e) => { console.error(e); process.exit(1); });
