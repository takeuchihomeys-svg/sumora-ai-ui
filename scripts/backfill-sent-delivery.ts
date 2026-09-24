// sent_properties.delivery / channel と sent_image_properties.channel を source から埋め戻す（2026-09-24）
//   既定は下見だけ（件数と変わる行10件を出す）。--apply で書く。**実行は親（竹内さん確認後）が判断する**
//   読み手は rowDelivery / rowChannel（app/lib/sent-delivery.ts）が source から導くので、埋め戻さなくても動く。
//   埋め戻しは集計を速く・分かりやすくするため。
// 実行: npx tsx --env-file=.env.local scripts/backfill-sent-delivery.ts [--apply]
// ⚠ お客様の名前は出さない（物件名・号室まで）
import { createClient } from "@supabase/supabase-js";
import { channelFromSource, deliveryFromSource } from "../app/lib/sent-delivery";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLY = process.argv.includes("--apply");

type SpRow = { id: string; source: string | null; image_url: string | null; property_name: string | null; room_no: string | null };

async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(APPLY ? "=== 書き込みモード（--apply）===" : "=== 下見（書き込みなし）===");

  // ① sent_properties: delivery が NULL の行
  const rows = await pageAll<SpRow>((a, b) => sb.from("sent_properties").select("id, source, image_url, property_name, room_no").is("delivery", null).order("id").range(a, b));
  console.log(`sent_properties delivery IS NULL: ${rows.length}行`);

  // vision で画像がある行は、sent_image_properties の同じ画像の source（aix:*）から経路を補う
  const visionImgs = [...new Set(rows.filter((r) => r.source === "vision" && r.image_url).map((r) => r.image_url!))];
  const imgSource = new Map<string, string>();
  for (let i = 0; i < visionImgs.length; i += 200) {
    const { data } = await sb.from("sent_image_properties").select("image_url, source").in("image_url", visionImgs.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ image_url: string; source: string | null }>) if (r.source?.startsWith("aix:")) imgSource.set(r.image_url, r.source);
  }

  const plan = rows.map((r) => {
    let channel = channelFromSource(r.source);
    if (!channel && r.source === "vision" && r.image_url && imgSource.has(r.image_url)) channel = channelFromSource(imgSource.get(r.image_url));
    return { ...r, delivery: deliveryFromSource(r.source), channel };
  });
  const byKey = new Map<string, number>();
  for (const p of plan) { const k = `${p.source ?? "null"} → delivery=${p.delivery}, channel=${p.channel ?? "null"}`; byKey.set(k, (byKey.get(k) ?? 0) + 1); }
  console.log("種類ごとの件数（前: delivery/channel=NULL → 後）:");
  for (const [k, n] of [...byKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
  console.log(`  vision のうち画像の記録から経路を補える行: ${plan.filter((p) => p.source === "vision" && p.channel).length}`);
  console.log("変わる行（10件・物件名と号室まで）:");
  for (const p of plan.filter((x) => x.source !== "line_group").slice(0, 5).concat(plan.filter((x) => x.source === "line_group").slice(0, 5))) {
    console.log(`  ${p.id.slice(0, 8)} ${p.property_name ?? ""} ${p.room_no ?? ""}  source=${p.source} → delivery=${p.delivery}, channel=${p.channel ?? "null"}`);
  }

  // ② sent_image_properties: channel が NULL の行
  const imgRows = await pageAll<{ image_url: string; source: string | null }>((a, b) => sb.from("sent_image_properties").select("image_url, source").is("channel", null).order("image_url").range(a, b));
  const imgPlan = imgRows.map((r) => ({ ...r, channel: channelFromSource(r.source) })).filter((r) => r.channel);
  const imgBy = new Map<string, number>();
  for (const r of imgPlan) imgBy.set(`${r.source} → ${r.channel}`, (imgBy.get(`${r.source} → ${r.channel}`) ?? 0) + 1);
  console.log(`\nsent_image_properties channel IS NULL: ${imgRows.length}行（経路を入れられる行 ${imgPlan.length}）`);
  for (const [k, n] of imgBy) console.log(`  ${String(n).padStart(6)}  ${k}`);

  if (!APPLY) { console.log("\n下見のみ。書くときは --apply"); return; }

  // 書き込み: 同じ (delivery, channel) の組ごとに id をまとめて update（delivery IS NULL の行だけ＝後から書かれた値は上書きしない）
  const groups = new Map<string, string[]>();
  for (const p of plan) { const k = `${p.delivery}|${p.channel ?? ""}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(p.id); }
  let done = 0;
  for (const [k, ids] of groups) {
    const [delivery, channel] = k.split("|");
    for (let i = 0; i < ids.length; i += 200) {
      const upd: Record<string, string> = { delivery };
      if (channel) upd.channel = channel;
      const { error } = await sb.from("sent_properties").update(upd).in("id", ids.slice(i, i + 200)).is("delivery", null);
      if (error) console.log(`⚠ ${k}: ${error.message}`); else done += Math.min(200, ids.length - i);
    }
  }
  console.log(`sent_properties 更新: ${done}行`);
  let imgDone = 0;
  const imgGroups = new Map<string, string[]>();
  for (const r of imgPlan) (imgGroups.get(r.channel!) ?? imgGroups.set(r.channel!, []).get(r.channel!)!).push(r.image_url);
  for (const [channel, urls] of imgGroups) {
    for (let i = 0; i < urls.length; i += 100) {
      const { error } = await sb.from("sent_image_properties").update({ channel }).in("image_url", urls.slice(i, i + 100)).is("channel", null);
      if (error) console.log(`⚠ image ${channel}: ${error.message}`); else imgDone += Math.min(100, urls.length - i);
    }
  }
  console.log(`sent_image_properties 更新: ${imgDone}行`);
}
main().catch((e) => { console.error(e); process.exit(1); });
