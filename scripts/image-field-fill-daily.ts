/**
 * 画像の種類ごとの欄の埋まりを quality_daily に書く（2026-11-21 作業員G・台帳 #505 の子・LLM なし）
 *   決まりは app/lib/image-field-fill.ts。前の日（JST）に入った行だけを読む（軽い）。夜の便・N の毎朝の1枚（scripts/self-improve.ts）が読む。
 *
 *   npx tsx --env-file=.env.local scripts/image-field-fill-daily.ts            # 数えて出すだけ
 *   npx tsx --env-file=.env.local scripts/image-field-fill-daily.ts --write    # quality_daily に書く（source=scripts/image-field-fill-daily.ts）
 *   --day=2026-11-20 で日を指定（既定は前の日）
 */
import { supabase } from "../app/lib/supabase-server";
import { customerFillMetrics, sentFillMetrics, type CustomerRow, type SentRow } from "../app/lib/image-field-fill";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const write = process.argv.includes("--write");
const jstDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

(async () => {
  const day = arg("day") ?? jstDay(Date.now() - 864e5);
  const from = new Date(Date.parse(`${day}T00:00:00+09:00`)).toISOString();
  const to = new Date(Date.parse(`${day}T00:00:00+09:00`) + 864e5).toISOString();
  const [{ data: cust, error: e1 }, { data: sent, error: e2 }] = await Promise.all([
    supabase.from("customer_image_records").select("kind, property_name, room_no, rent_yen, madori, area_sqm, station, walk_min, age_years").gte("created_at", from).lt("created_at", to).limit(2000),
    supabase.from("sent_image_properties").select("channel, source, property_name, room_no, facts").gte("created_at", from).lt("created_at", to).limit(5000),
  ]);
  if (e1 || e2) throw new Error((e1 ?? e2)!.message);
  const metrics = [...customerFillMetrics((cust ?? []) as CustomerRow[]), ...sentFillMetrics((sent ?? []) as SentRow[])];
  console.log(`${day}（JST）: お客様の画像 ${(cust ?? []).length}枚・こちらの画像 ${(sent ?? []).length}枚 → 物差し ${metrics.length}行`);
  for (const m of metrics) console.log(`  ${m.metric}  ${(m.value * 100).toFixed(0)}%  n=${m.n}`);
  if (write && metrics.length) {
    const rows = metrics.map((m) => ({ day, metric: m.metric, scope: "all", value: m.value, n: m.n, source: "scripts/image-field-fill-daily.ts" }));
    const { error } = await supabase.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
    if (error) throw new Error(`quality_daily: ${error.message}`);
    console.log(`quality_daily に ${rows.length}行`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
