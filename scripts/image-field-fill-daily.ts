/**
 * 画像の種類ごとの欄の埋まりを quality_daily に書く（2026-11-21 作業員G・台帳 #505 の子・LLM なし）
 *   決まりは app/lib/image-field-fill.ts。前の日（JST）に入った行だけを読む（軽い）。夜の便・N の毎朝の1枚（scripts/self-improve.ts）が読む。
 *
 *   npx tsx --env-file=.env.local scripts/image-field-fill-daily.ts            # 数えて出すだけ
 *   npx tsx --env-file=.env.local scripts/image-field-fill-daily.ts --write    # quality_daily に書く（source=scripts/image-field-fill-daily.ts）
 *   --day=2026-11-20 で日を指定（既定は前の日）
 */
import { supabase } from "../app/lib/supabase-server";
import { customerFillMetrics, sentFillMetrics, counterKitchenAgreement, type CustomerRow, type SentRow } from "../app/lib/image-field-fill";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const write = process.argv.includes("--write");
const jstDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

(async () => {
  const day = arg("day") ?? jstDay(Date.now() - 864e5);
  const from = new Date(Date.parse(`${day}T00:00:00+09:00`)).toISOString();
  const to = new Date(Date.parse(`${day}T00:00:00+09:00`) + 864e5).toISOString();
  const [{ data: cust, error: e1 }, { data: sent0, error: e2 }] = await Promise.all([
    supabase.from("customer_image_records").select("kind, property_name, room_no, rent_yen, madori, area_sqm, station, walk_min, age_years").gte("created_at", from).lt("created_at", to).limit(2000),
    supabase.from("sent_image_properties").select("image_url, channel, source, property_name, room_no, facts").gte("created_at", from).lt("created_at", to).limit(5000),
  ]);
  if (e1 || e2) throw new Error((e1 ?? e2)!.message);
  let sent = sent0;
  // 2026-11-22 作業員G（#509）: 見積書の画像（image_details.kind=estimate）はこちらの画像の欄の埋まりから除く（間取り・築年が無いのが正しい）
  {
    const urls = ((sent ?? []) as Array<{ image_url?: string }>).map((r) => r.image_url).filter((u): u is string => !!u);
    const est = new Set<string>(), prop = new Set<string>();
    for (let i = 0; i < urls.length; i += 100) {
      const { data: d } = await supabase.from("image_details").select("image_url, kind").in("kind", ["estimate", "property"]).in("image_url", urls.slice(i, i + 100));
      for (const r of (d ?? []) as Array<{ image_url: string; kind: string }>) (r.kind === "estimate" ? est : prop).add(r.image_url);
    }
    // 2026-11-23 作業員G（統括役 案1）: 写真など＝書き写しの読みが物件の資料として無く、値（facts）も1つも無い画像も「元が無い」として除く
    const rows = (sent ?? []) as Array<{ image_url?: string; facts?: unknown }>;
    const isPhoto = (r: { image_url?: string; facts?: unknown }) => !prop.has(r.image_url ?? "") && (r.facts == null || (typeof r.facts === "object" && Object.keys(r.facts as object).filter((k) => !["src", "model"].includes(k)).length === 0));
    const photoN = rows.filter((r) => !est.has(r.image_url ?? "") && isPhoto(r)).length;
    sent = rows.filter((r) => !est.has(r.image_url ?? "") && !isPhoto(r)) as typeof sent;
    if (est.size || photoN) console.log(`見積書の画像 ${est.size}枚・写真など（読みも値も無い）${photoN}枚を除いた`);
  }
  // 2026-11-22 作業員G（#587）: カウンターキッチンの文字の札と画像の読みの食い違い（画像で読んだ行だけ）
  const { data: pk, error: e3 } = await supabase.from("property_pickups").select("id, ck_text:equipment->facts->counter_kitchen->>s, ck_image:image_facts->counter_kitchen")
    .gte("created_at", from).lt("created_at", to).not("image_facts->counter_kitchen", "is", null).limit(2000);
  if (e3) throw new Error(e3.message);
  const ck = counterKitchenAgreement(((pk ?? []) as Array<{ id: number; ck_text: string | null; ck_image: unknown }>)
    .map((r) => ({ id: r.id, text: r.ck_text, image: r.ck_image === true ? true : r.ck_image === false ? false : null })));
  if (ck.mismatchIds.length || ck.imageOnlyIds.length) console.log(`カウンターキッチン: 食い違い ${ck.mismatchIds.join(",") || "—"}・図だけで有る ${ck.imageOnlyIds.join(",") || "—"}（目の監査へ: scripts/counter-kitchen-image-audit.ts --topic=counter_kitchen_v2 --ids=…）`);
  const metrics = [...customerFillMetrics((cust ?? []) as CustomerRow[]), ...sentFillMetrics((sent ?? []) as SentRow[]), ...ck.metrics];
  console.log(`${day}（JST）: お客様の画像 ${(cust ?? []).length}枚・こちらの画像 ${(sent ?? []).length}枚 → 物差し ${metrics.length}行`);
  for (const m of metrics) console.log(`  ${m.metric}  ${(m.value * 100).toFixed(0)}%  n=${m.n}`);
  if (write && metrics.length) {
    const rows = metrics.map((m) => ({ day, metric: m.metric, scope: "all", value: m.value, n: m.n, source: "scripts/image-field-fill-daily.ts" }));
    const { error } = await supabase.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
    if (error) throw new Error(`quality_daily: ${error.message}`);
    console.log(`quality_daily に ${rows.length}行`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
