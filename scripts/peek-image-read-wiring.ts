// スタッフが送った画像の読み取りが**実際に動いているか**を数える（読み取りのみ）
// 2026-09-21 竹内「こっちが送った画像なら deepseek で読み取れるようになってるはず」
// 実行: npx tsx --env-file=.env.local scripts/peek-image-read-wiring.ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  // ① sent_image_properties の source 別・日別
  const { data: sip, error: e1 } = await sb.from("sent_image_properties")
    .select("image_url, source, created_at").order("created_at", { ascending: false }).limit(1000);
  if (e1) console.log("⚠ sent_image_properties:", e1.message);
  const rows = (sip ?? []) as Array<{ source: string | null; created_at: string }>;
  const bySrc = new Map<string, number>();
  for (const r of rows) bySrc.set(r.source ?? "null", (bySrc.get(r.source ?? "null") ?? 0) + 1);
  console.log(`=== sent_image_properties 直近1000件 ===`);
  for (const [k, v] of [...bySrc].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log(`  最新: ${rows[0]?.created_at ?? "-"} / 最古(この1000件): ${rows[rows.length - 1]?.created_at ?? "-"}\n`);

  // ② スタッフが送った画像（messages）— 直近30日
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const staffImgs: Array<{ image_url: string | null; created_at: string; conversation_id: string }> = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("messages")
      .select("image_url, created_at, conversation_id")
      .eq("sender", "staff").not("image_url", "is", null).gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠ messages:", error.message); break; }
    const r = (data ?? []) as typeof staffImgs;
    staffImgs.push(...r); if (r.length < 1000) break;
  }
  const urls = [...new Set(staffImgs.map((m) => m.image_url!).filter(Boolean))];
  console.log(`=== 直近30日 スタッフ送信画像 ${staffImgs.length}件（ユニークURL ${urls.length}）===`);

  const known = new Set<string>();
  for (const table of ["sent_image_properties", "sent_properties"] as const) {
    for (let i = 0; i < urls.length; i += 25) {
      const { data, error } = await sb.from(table).select("image_url, property_name").in("image_url", urls.slice(i, i + 25));
      if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
      for (const r of (data ?? []) as Array<{ image_url: string; property_name: string | null }>) if (r.property_name) known.add(r.image_url);
    }
  }
  const pct = urls.length ? ((known.size / urls.length) * 100).toFixed(1) : "0";
  console.log(`  物件に直せている: ${known.size} / ${urls.length}（${pct}%）`);
  const convs = new Set(staffImgs.map((m) => m.conversation_id));
  const convKnown = new Set(staffImgs.filter((m) => m.image_url && known.has(m.image_url)).map((m) => m.conversation_id));
  console.log(`  画像を送った会話 ${convs.size} 件のうち、1枚でも直せている会話 ${convKnown.size} 件\n`);

  // ③ 直近7日だけで見る（9/20 に経路が入ったなら増えているはず）
  const since7 = Date.now() - 7 * 86400_000;
  const u7 = [...new Set(staffImgs.filter((m) => Date.parse(m.created_at) >= since7).map((m) => m.image_url!))];
  const k7 = u7.filter((u) => known.has(u)).length;
  console.log(`  直近7日: ${k7} / ${u7.length}（${u7.length ? ((k7 / u7.length) * 100).toFixed(1) : "0"}%）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
