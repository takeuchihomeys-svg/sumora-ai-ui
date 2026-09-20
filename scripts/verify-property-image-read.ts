// scripts/verify-property-image-read.ts
// 実行: npx tsx --env-file=.env.local scripts/verify-property-image-read.ts [--n=10]
//
// 2026-09-20 竹内「お客さん毎に送った物件のテーブル作ってそこから読み取れるようにすれば良いのでは。
//   その画像の読み込みに限定して deepseek V4.1 Flash のモデルを使う」
//
// スタッフが実際に送った画像を DeepSeek で読み、**照合まで通して**何件が記録できるかを測る。
//   ・読めた／読めない
//   ・照合を通った（既知の物件名と合った）／捨てた
//   ・費用（実測トークン × 公式価格）
// 読み取りのみ（DB には書かない）。
export {};
import { createClient } from "@supabase/supabase-js";
import { readPropertyImage } from "../app/lib/property-image-read";
import { resolveReadProperty } from "../app/lib/property-name-match";
import { extractPropertyLabels } from "../app/lib/action-ledger";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const N = Number((process.argv.find((a) => a.startsWith("--n=")) ?? "--n=10").split("=")[1]);
// DeepSeek 公式価格（ピーク）: 入力 $0.30/M・出力 $1.20/M
const IN_PRICE = 0.30, OUT_PRICE = 1.20;

/** その会話で既に分かっている物件名（sent_properties ＋ 本文の🌟【】） */
async function knownNames(conversationId: string): Promise<string[]> {
  const out = new Set<string>();
  const { data: sp } = await sb.from("sent_properties").select("property_name")
    .eq("conversation_id", conversationId).limit(50);
  for (const r of (sp ?? []) as Array<{ property_name: string | null }>) if (r.property_name) out.add(r.property_name.trim());
  const { data: ms } = await sb.from("messages").select("text")
    .eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(80);
  const joined = ((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n");
  for (const lbl of extractPropertyLabels(joined)) out.add(lbl.replace(/\s*[0-9０-９]{1,4}号室\s*$/, "").trim());
  return [...out].filter((s) => s.length >= 2);
}

async function main() {
  const { data } = await sb.from("messages").select("conversation_id, image_url, created_at")
    .eq("sender", "staff").not("image_url", "is", null)
    .gte("created_at", new Date(Date.now() - 20 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(N);
  const imgs = (data ?? []) as Array<{ conversation_id: string; image_url: string; created_at: string }>;
  console.log(`=== スタッフが送った画像 ${imgs.length}枚を DeepSeek で読む ===\n`);

  let read = 0, matched = 0, dropped = 0, notProperty = 0, inTok = 0, outTok = 0;
  for (const im of imgs) {
    const r = await readPropertyImage(im.image_url);
    inTok += r.usage?.input ?? 0; outTok += r.usage?.output ?? 0;
    const known = await knownNames(im.conversation_id);
    if (r.items.length === 0) {
      console.log(`  ${String(im.created_at).slice(5, 16)} －読めない  ${r.raw.replace(/\s+/g, " ").slice(0, 60)}`);
      continue;
    }
    read++;
    if (!r.isProperty) notProperty++;
    const fixed = r.items.map((x) => resolveReadProperty(x, known)).filter((x): x is NonNullable<typeof x> => !!x);
    if (fixed.length > 0) matched++; else dropped++;
    const label = r.items.map((x) => `${x.propertyName}${x.roomNumber ? ` ${x.roomNumber}` : ""}`).slice(0, 2).join(" / ");
    const fixedLabel = fixed.map((x) => `${x.propertyName}${x.roomNumber ? ` ${x.roomNumber}` : ""}`).slice(0, 2).join(" / ");
    console.log(`  ${String(im.created_at).slice(5, 16)} ${fixed.length > 0 ? "✅" : "⚠捨"} 読=${label.slice(0, 44)}${r.items.length > 2 ? `…計${r.items.length}` : ""}`);
    console.log(`${" ".repeat(20)}${fixed.length > 0 ? `→ ${fixedLabel}` : `既知${known.length}件と合わず`}`);
  }

  const cost = (inTok * IN_PRICE + outTok * OUT_PRICE) / 1_000_000;
  console.log(`\n--- まとめ（${imgs.length}枚）---`);
  console.log(`  物件名を読めた       ${read}枚`);
  console.log(`  うち照合を通った     ${matched}枚  ← sent_image_properties に記録できる`);
  console.log(`  うち捨てた           ${dropped}枚  ← 既知の名前と合わない（誤読の疑い）`);
  console.log(`  物件の資料ではない   ${notProperty}枚（見積書・書類など）`);
  console.log(`\n  トークン 入力${inTok} / 出力${outTok} = $${cost.toFixed(5)}（${imgs.length}枚）`);
  console.log(`  1枚あたり $${(cost / Math.max(imgs.length, 1)).toFixed(6)} → 54枚/日で **月$${(cost / Math.max(imgs.length, 1) * 54 * 30).toFixed(2)}**`);
}
main().catch((e) => { console.error(e); process.exit(1); });
