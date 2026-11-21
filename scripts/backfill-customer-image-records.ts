/**
 * お客様の画像の記録（customer_image_records）の過去分を埋める（2026-11-21 作業員G・決定論・LLM なし）
 *   書く形は本番と同じ recordCustomerImages（line-webhook の画像の後処理）。深い読み（CUSTOMER_IMAGE_DEEP_READ）は止めて回す。
 *   重い読み（messages の画像の行を日数分）なので夜（22時〜翌8時）だけ。既に行がある画像は upsert で上書き（同じ形）。
 *
 *   npx tsx --env-file=.env.local scripts/backfill-customer-image-records.ts --days=180            # 数えるだけ
 *   npx tsx --env-file=.env.local scripts/backfill-customer-image-records.ts --days=180 --write    # 書く
 */
process.env.CUSTOMER_IMAGE_DEEP_READ = "off";
import { supabase } from "../app/lib/supabase-server";
import { recordCustomerImages } from "../app/lib/customer-image-record-server";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const write = process.argv.includes("--write");

(async () => {
  const h = new Date(Date.now() + 9 * 3600e3).getUTCHours();
  if (write && h >= 9 && h < 22) throw new Error("重い読みなので 22時〜翌8時（JST）だけ");
  const days = Math.min(Number(arg("days") ?? 180) || 180, 400);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("messages").select("id").eq("sender", "customer").like("text", "[画像]%")
      .gte("created_at", since).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    ids.push(...((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    if (!data || data.length < 1000) break;
  }
  console.log(`${days}日のお客様の画像: ${ids.length}通`);
  if (!write) return;
  let rows = 0;
  for (let i = 0; i < ids.length; i += 50) {
    rows += await recordCustomerImages(supabase as never, ids.slice(i, i + 50));
    if ((i / 50) % 10 === 0) console.log(`  ${Math.min(i + 50, ids.length)}/${ids.length}・書いた ${rows}`);
  }
  console.log(`書いた: ${rows}行`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
