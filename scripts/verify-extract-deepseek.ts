// extract-property-info を DeepSeek に置き換えた後に、何が記録されるかを確かめる（読み取りのみ・DB に書かない）
// 2026-09-22 竹内「画像から物件名などを読み取る処理 deepseek に置き換える」
// 実行: npx tsx --env-file=.env.local scripts/verify-extract-deepseek.ts
import { createClient } from "@supabase/supabase-js";
import { readPropertyImage } from "../app/lib/property-image-read";
import { resolveReadProperty } from "../app/lib/property-name-match";
import { extractPropertyLabels } from "../app/lib/action-ledger";

/** extract-property-info と同じ辞書（その会話の送った物件名＋本文の物件名） */
async function knownNames(conversationId: string): Promise<string[]> {
  const known = new Set<string>();
  const { data: sp } = await sb.from("sent_properties").select("property_name").eq("conversation_id", conversationId).limit(50);
  for (const r of (sp ?? []) as Array<{ property_name: string | null }>) if (r.property_name) known.add(r.property_name.trim());
  const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(80);
  for (const l of extractPropertyLabels(((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n"))) known.add(l.replace(/\s*[0-9０-９]{1,4}号室\s*$/, "").trim());
  return [...known].filter((s) => s.length >= 2);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  // 物件資料（旧 Haiku が記録した名前と並べる）6枚 ＋ 見積書 2枚
  const { data: props } = await sb.from("sent_image_properties").select("image_url, conversation_id, property_name, room_no, source")
    .order("created_at", { ascending: false }).limit(6);
  const { data: ests } = await sb.from("image_details").select("image_url, conversation_id").eq("kind", "estimate").order("read_at", { ascending: false }).limit(2);
  const cases = [
    ...((props ?? []) as Array<{ image_url: string; conversation_id: string; property_name: string; room_no: string | null; source: string }>).map((r) => ({ url: r.image_url, conv: r.conversation_id, before: `${r.property_name} ${r.room_no ?? ""}（${r.source}）`, expectProperty: true })),
    ...((ests ?? []) as Array<{ image_url: string; conversation_id: string | null }>).map((r) => ({ url: r.image_url, conv: r.conversation_id ?? "", before: "（見積書）", expectProperty: false })),
  ];
  let ok = 0, estOk = 0, ms = 0;
  for (const c of cases) {
    const t0 = Date.now();
    const r = await readPropertyImage(c.url, { timeoutMs: 80_000 });
    ms += Date.now() - t0;
    const top = r.isProperty ? r.items[0] : undefined;
    const fixed = top && c.conv ? resolveReadProperty(top, await knownNames(c.conv)) : null;
    const named = fixed ?? top;
    const now = named ? `${named.propertyName} ${named.roomNumber}${fixed ? "（照合で修正）" : "（照合なし）"}` : "（記録しない）";
    if (c.expectProperty && top) ok++;
    if (!c.expectProperty && !top) estOk++;
    console.log(`${String(Date.now() - t0).padStart(6)}ms  記録済み: ${c.before.padEnd(34)} → DeepSeek: ${now}`);
  }
  console.log(`\n物件資料で名前が取れた ${ok}/${cases.filter((c) => c.expectProperty).length} ／ 見積書を物件として記録しない ${estOk}/${cases.filter((c) => !c.expectProperty).length} ／ 平均 ${Math.round(ms / cases.length)}ms`);
}
main().catch((e) => { console.error(e); process.exit(1); });
