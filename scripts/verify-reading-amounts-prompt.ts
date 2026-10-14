// scripts/verify-reading-amounts-prompt.ts — 物件名・金額の読み取りの指示（PROPERTY_IMAGE_PROMPT・10/14 に「万円」と日本語の漢字の行を足した）を、
//   金額を取り違えていた送った画像で読み直して、前の保存（facts）と資料の文字の層を並べる（DeepSeek・推論なし・1枚ずつ・DB には書かない）
// 2026-10-14 竹内さん「金額の読み取りを実データで測る…取り違えを直す」。費用は 1枚 約$0.0005（llm_usage_logs にも書かない＝本番 DB は読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/verify-reading-amounts-prompt.ts [--names=パレーシャル難波,プレミアム新福島]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const names = (process.argv.find((a) => a.startsWith("--names=")) ?? "--names=パレーシャル難波,プレミアム新福島,トップヒル森河内,レフジアコート平野").split("=")[1].split(",");

async function main() {
  const { PROPERTY_IMAGE_PROMPT, PROPERTY_IMAGE_ENDPOINT, parseReadResult, PROPERTY_IMAGE_READ_NO_THINKING_MAX_TOKENS } = await import("../app/lib/property-image-read");
  const { factsFromImageRead } = await import("../app/lib/candidate-facts");
  const { checkReadAmounts } = await import("../app/lib/reading-amounts");
  const { CHINESE_FORM_RE } = await import("../app/lib/ja-kanji");
  let inTok = 0, outTok = 0, calls = 0;
  for (const n of names) {
    const { data } = await sb.from("sent_image_properties").select("image_url, property_name, room_no, facts").ilike("property_name", `%${n}%`).not("facts", "is", null).limit(1);
    const row = (data ?? [])[0] as { image_url: string; property_name: string; room_no: string | null; facts: Record<string, unknown> } | undefined;
    if (!row) { console.log(`${n}: 画像なし`); continue; }
    const res = await fetch(PROPERTY_IMAGE_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: process.env.PROPERTY_IMAGE_MODEL ?? "deepseek-flash", max_tokens: PROPERTY_IMAGE_READ_NO_THINKING_MAX_TOKENS, thinking: { type: "disabled" }, temperature: 0,
        messages: [{ role: "user", content: [{ type: "text", text: PROPERTY_IMAGE_PROMPT }, { type: "image_url", image_url: { url: row.image_url } }] }] }),
      signal: AbortSignal.timeout(60_000),
    });
    calls++;
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    inTok += j.usage?.prompt_tokens ?? 0; outTok += j.usage?.completion_tokens ?? 0;
    const content = String(j.choices?.[0]?.message?.content ?? "");
    const r = parseReadResult(content);
    const it = r.items[0];
    const f = it ? checkReadAmounts(factsFromImageRead(it)).facts : {};
    const pick = (o: Record<string, unknown>) => ({ rent: o.rent, admin: o.admin_fee_yen, depM: o.deposit_months, depY: o.deposit_yen, keyM: o.key_money_months, keyY: o.key_money_yen });
    console.log(`${row.property_name} ${row.room_no ?? ""}\n   前の保存: ${JSON.stringify(pick(row.facts))}\n   読み直し: ${JSON.stringify(pick(f as Record<string, unknown>))} 名前「${it?.propertyName ?? ""}」号室「${it?.roomNumber ?? ""}」中国の字形 ${CHINESE_FORM_RE.test(content) ? "あり" : "なし"}`);
  }
  console.log(`DeepSeek ${calls}回・入力 ${inTok}・出力 ${outTok}（約 $${((inTok * 0.27 + outTok * 1.1) / 1e6).toFixed(4)}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
