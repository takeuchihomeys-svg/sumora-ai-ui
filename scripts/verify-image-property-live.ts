// scripts/verify-image-property-live.ts
// 実行: npx tsx --env-file=.env.local scripts/verify-image-property-live.ts
//
// 2026-09-20 竹内「お客さん毎に送った物件のテーブル作ってそこから読み取れるようにすれば良いのでは」
//   送信の経路（send-line-message）で画像を送った時に、本当に sent_image_properties へ
//   記録されるかを**本番で**確かめる。
//
// ⚠ 実際に LINE 送信が走るので、テスト会話「YUMA」（竹内さん本人）だけを使い、
//   送ったメッセージと書いた行は**必ず片付ける**。
export {};
import { createClient } from "@supabase/supabase-js";
const BASE = process.env.VERIFY_BASE_URL ?? "https://sumora-ai-ui.vercel.app";
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const { data: conv } = await sb.from("conversations").select("line_user_id, account, customer_name").eq("id", CONV).maybeSingle();
  const c = conv as { line_user_id: string; account: string | null; customer_name: string | null } | null;
  if (!c?.line_user_id) { console.error("YUMA の line_user_id が取れない"); process.exit(1); }

  // 実物の物件画像を1枚選ぶ（既に物件名が読めると分かっている物）
  const { data: imgs } = await sb.from("messages").select("image_url, conversation_id, created_at")
    .eq("sender", "staff").not("image_url", "is", null)
    .gte("created_at", new Date(Date.now() - 20 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(1);
  const src = ((imgs ?? []) as Array<{ image_url: string }>)[0];
  if (!src) { console.error("画像が見つからない"); process.exit(1); }
  console.log(`── 送る画像: ${src.image_url.slice(0, 90)}\n`);

  // 照合の辞書になるよう、その物件名を本文にも含めて送る（実運用でもスタッフは本文に物件名を書く）
  const before = new Date().toISOString();
  const res = await fetch(`${BASE}/api/send-line-message`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      line_user_id: c.line_user_id, account: c.account ?? "sumora",
      conversation_id: CONV, image_url: src.image_url, origin: "verify",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  console.log(`── 送信: HTTP ${res.status} ${body.slice(0, 120)}`);
  if (!res.ok) { console.error("送信に失敗したので中止"); process.exit(1); }

  // after() は応答の後に走るので少し待つ
  for (let i = 1; i <= 8; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const { data } = await sb.from("sent_image_properties")
      .select("image_url, property_name, room_no, source, created_at")
      .eq("conversation_id", CONV).gte("created_at", before).limit(5);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      console.log(`\n✅ ${i * 5}秒後に記録された:`);
      for (const r of rows) console.log(`   ${r.property_name} ${r.room_no}（source=${r.source}）`);
      // ── 片付け（書いた行を消す）──
      const { error } = await sb.from("sent_image_properties").delete().eq("conversation_id", CONV).gte("created_at", before);
      console.log(`\n── 片付け: ${error ? `⚠ ${error.message}` : "✅ 書いた行を消した"}`);
      console.log(`   ⚠ YUMA に送った画像のメッセージは LINE 上に残る（テスト会話なのでそのまま）`);
      return;
    }
    console.log(`   ${i * 5}秒: まだ記録なし`);
  }
  console.log(`\n⚠ 40秒待っても記録されなかった。Vercel のログ（tag: send-line-message:image-property）を確認する`);
}
main().catch((e) => { console.error(e); process.exit(1); });
