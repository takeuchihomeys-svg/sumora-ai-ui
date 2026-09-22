// 画像の読み取り（DeepSeek）でプロンプトキャッシュが効いているかを測る（読み取りのみ・DB に書かない）
// 2026-09-22 竹内「プロンプトキャッシュもちゃんとできているのか」
// 実行: npx tsx --env-file=.env.local scripts/measure-image-read-cache.ts
import { createClient } from "@supabase/supabase-js";
import { readPropertyImage } from "../app/lib/property-image-read";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const { data } = await sb.from("image_details").select("image_url").eq("kind", "property").order("read_at", { ascending: false }).limit(2);
  const [a, b] = ((data ?? []) as Array<{ image_url: string }>).map((r) => r.image_url);
  const order: Array<[string, string]> = [["画像A 1回目", a], ["画像A 2回目（同じ画像）", a], ["画像B 1回目（別の画像）", b], ["画像B 2回目（同じ画像）", b]];
  for (const [label, url] of order) {
    const r = await readPropertyImage(url, { timeoutMs: 80_000 });
    const u = r.usage ?? { input: 0, output: 0, cacheHit: 0 };
    const pct = u.input ? Math.round(((u.cacheHit ?? 0) / u.input) * 100) : 0;
    console.log(`${label.padEnd(22)} 入力 ${String(u.input).padStart(5)} のうちキャッシュ ${String(u.cacheHit ?? 0).padStart(5)}（${pct}%）／出力 ${u.output}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
