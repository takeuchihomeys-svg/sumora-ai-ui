// scripts/audit-sent-property-tables.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-sent-property-tables.ts [--days=30]
//
// 2026-09-20 竹内「お客さん毎に送った物件のテーブル作ってそこから読み取れるようにすれば良いのでは」
//   → **既に2つある**ので、まず現状（何が埋まっていて何が欠けているか）を測る:
//     sent_properties        … 顧客ごとの送付物件（ブレインの【すでに送付済みの物件】）
//     sent_image_properties  … 画像ごとの物件対応（みく事例で作った・引用返信の解決用）
//   欠けの原因が「記録されていない」のか「引き方」なのかを分ける。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);

async function head(table: string, build: (q: ReturnType<typeof sb.from>) => unknown) {
  try {
    const q = build(sb.from(table)) as { then: unknown };
    const r = (await (q as unknown as Promise<{ count: number | null; error: { message: string } | null }>));
    return r.error ? `⚠ ${r.error.message}` : String(r.count ?? 0);
  } catch (e) { return `⚠ ${e instanceof Error ? e.message : String(e)}`; }
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  console.log(`=== 送付物件のテーブルの現状（直近${DAYS}日）===\n`);

  for (const t of ["sent_properties", "sent_image_properties"]) {
    const all = await head(t, (q) => q.select("id", { count: "exact", head: true }));
    const recent = await head(t, (q) => q.select("id", { count: "exact", head: true }).gte("created_at", since));
    console.log(`  ${t.padEnd(24)} 全体 ${String(all).padStart(6)}行 / 直近${DAYS}日 ${String(recent).padStart(5)}行`);
  }

  // sent_properties の列と、conversation_id / property_customer_id の埋まり方
  const { data: sp } = await sb.from("sent_properties").select("*").gte("created_at", since).limit(400);
  const rows = (sp ?? []) as Array<Record<string, unknown>>;
  if (rows.length > 0) {
    console.log(`\n--- sent_properties の列 ---\n  ${Object.keys(rows[0]).join(" / ")}`);
    const filled = (k: string) => rows.filter((r) => r[k] != null && String(r[k]).trim() !== "").length;
    console.log(`\n--- 直近${DAYS}日 ${rows.length}行の埋まり方 ---`);
    for (const k of ["conversation_id", "property_customer_id", "property_name", "room_no", "rent", "sent_at", "source", "image_url"]) {
      if (!(k in rows[0])) continue;
      console.log(`  ${k.padEnd(22)} ${String(filled(k)).padStart(4)}/${rows.length} (${Math.round(100 * filled(k) / rows.length)}%)`);
    }
  }

  // sent_image_properties の中身
  const { data: sip } = await sb.from("sent_image_properties").select("*").gte("created_at", since).limit(300);
  const irows = (sip ?? []) as Array<Record<string, unknown>>;
  if (irows.length > 0) {
    console.log(`\n--- sent_image_properties の列 ---\n  ${Object.keys(irows[0]).join(" / ")}`);
    const f = (k: string) => irows.filter((r) => r[k] != null && String(r[k]).trim() !== "").length;
    console.log(`\n--- 直近${DAYS}日 ${irows.length}行の埋まり方 ---`);
    for (const k of Object.keys(irows[0])) console.log(`  ${k.padEnd(22)} ${String(f(k)).padStart(4)}/${irows.length} (${Math.round(100 * f(k) / irows.length)}%)`);
  } else {
    console.log(`\n  ⚠ sent_image_properties は直近${DAYS}日に0行`);
  }

  // スタッフが送った画像のうち、物件に直せている割合
  const { data: imgs } = await sb.from("messages").select("id, conversation_id, text")
    .eq("sender", "staff").not("image_url", "is", null).gte("created_at", since).limit(1000);
  const staffImgs = (imgs ?? []) as Array<{ id: string; conversation_id: string; text: string | null }>;
  let mapped = 0;
  for (let i = 0; i < staffImgs.length; i += 100) {
    const ids = staffImgs.slice(i, i + 100).map((m) => m.id);
    const { data } = await sb.from("sent_image_properties").select("message_id").in("message_id", ids);
    mapped += (data ?? []).length;
  }
  console.log(`\n--- スタッフが送った画像 ${staffImgs.length}件（直近${DAYS}日）---`);
  console.log(`  sent_image_properties で物件に直せている: ${mapped}件 (${Math.round(100 * mapped / Math.max(staffImgs.length, 1))}%)`);
  console.log(`  **物件に直せていない: ${staffImgs.length - mapped}件** ← ここが竹内さんの言う「読み取れていない画像」`);
}
main().catch((e) => { console.error(e); process.exit(1); });
