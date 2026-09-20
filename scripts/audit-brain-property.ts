// scripts/audit-brain-property.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-property.ts [--days=30]
//
// 2026-09-20 竹内「物件特定できていないとあるが、物件把握できていないのかな？
//   ブレインにもれがあるのか。ここで物件把握できていなかったら文にすれ違いが起きる可能性ある」
//
// ブレインが物件を知る経路は3つ。どこで落ちているかを実データで数える:
//   ① sent_properties テーブル（【すでに送付済みの物件】ブロック）
//   ② 行動台帳 action-ledger の propertiesSent / 物件名（会話本文から抽出）
//   ③ suggested_aix_meta.current_property（ブレイン自身が書いた「今の物件」）
// 会話本文に物件名が出ているのに ①②③ が空なら、**ブレインは物件を知らない**。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { extractPropertyLabels } from "../app/lib/action-ledger";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);

/** スタッフが物件を送った形（実送信の主流）: 🌟物件名 / 【物件名 N号室】 */
const SENT_PROPERTY_RE = /🌟\s*\S|【[^】]{2,40}\s*[0-9０-９]{2,4}号室】/;
/** 画像だけで送った（本文に物件名が無い） */
const IMAGE_ONLY_RE = /^\s*(?:\[(?:画像|動画|ファイル)\]\s*)+$/;

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data: convs } = await sb.from("conversations")
    .select("id, customer_name, status, updated_at, suggested_aix_meta")
    .gte("updated_at", since).order("updated_at", { ascending: false }).limit(400);
  const list = (convs ?? []) as Array<Record<string, unknown>>;
  console.log(`=== 直近${DAYS}日に動いた会話 ${list.length}件 ===\n`);

  let withProp = 0, noSentProps = 0, noLedger = 0, noCurrent = 0, imageOnly = 0;
  const holes: Array<{ name: string; status: string; labels: string[]; sent: number; current: string; imgOnly: number }> = [];

  for (const c of list) {
    const { data: msgs } = await sb.from("messages")
      .select("sender, text, image_url, created_at").eq("conversation_id", c.id as string)
      .order("created_at", { ascending: false }).limit(60);
    const ms = (msgs ?? []) as Array<{ sender: string; text: string | null; image_url: string | null }>;
    const staffTexts = ms.filter((m) => m.sender === "staff").map((m) => m.text ?? "");
    const hasPropertyInText = staffTexts.some((t) => SENT_PROPERTY_RE.test(t));
    // 画像だけ送っている（本文に物件名が無い）通の数
    const imgOnlyCount = ms.filter((m) => m.sender === "staff" && (m.image_url || IMAGE_ONLY_RE.test(m.text ?? ""))).length;
    if (!hasPropertyInText && imgOnlyCount === 0) continue;   // 物件を送っていない会話は対象外
    withProp++;

    const { count: sentCount } = await sb.from("sent_properties")
      .select("id", { count: "exact", head: true }).eq("conversation_id", c.id as string);
    const labels = extractPropertyLabels(staffTexts.join("\n"));
    const meta = c.suggested_aix_meta as Record<string, unknown> | null;
    const current = String(meta?.current_property ?? "").trim();

    if ((sentCount ?? 0) === 0) noSentProps++;
    if (labels.length === 0) noLedger++;
    if (!current) noCurrent++;
    if (!hasPropertyInText && imgOnlyCount > 0) imageOnly++;

    // 3つとも空＝ブレインは物件を1つも知らない
    if ((sentCount ?? 0) === 0 && labels.length === 0 && !current) {
      holes.push({ name: String(c.customer_name), status: String(c.status ?? ""), labels, sent: sentCount ?? 0, current, imgOnly: imgOnlyCount });
    }
  }

  const pct = (n: number) => `${Math.round((100 * n) / Math.max(withProp, 1))}%`;
  console.log(`--- 物件を送っている会話 ${withProp}件 のうち ---`);
  console.log(`  ① sent_properties が0件            ${String(noSentProps).padStart(3)}件 (${pct(noSentProps)})  ← ブレインの【送付済みの物件】が空`);
  console.log(`  ② 本文から物件名を1つも取れない      ${String(noLedger).padStart(3)}件 (${pct(noLedger)})  ← 行動台帳・材料が空`);
  console.log(`  ③ current_property が空             ${String(noCurrent).padStart(3)}件 (${pct(noCurrent)})  ← ブレイン自身が物件を書いていない`);
  console.log(`  画像だけで送っている（本文に物件名なし）${String(imageOnly).padStart(3)}件 (${pct(imageOnly)})`);
  console.log(`\n  **①②③が全部空（ブレインは物件を1つも知らない）: ${holes.length}件 (${pct(holes.length)})**`);
  for (const h of holes.slice(0, 15)) {
    console.log(`     ${h.name.padEnd(14)} [${h.status}] 画像のみ${h.imgOnly}通`);
  }
  if (holes.length > 15) console.log(`     …ほか ${holes.length - 15}件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
