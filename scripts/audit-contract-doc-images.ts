// scripts/audit-contract-doc-images.ts — 読むだけ・LLM なし・消さない（2026-11-15 作業員H・統括役の頼み①）
//   お客様の画像の保存の本文のうち、契約書・保証会社の書類・申込書・同意書の語を含む行を全期間で数え、
//   契約書の網（image-label.CONTRACT_DOC_RE・IMAGE_LABEL_1115）に当たるか・中身（氏名・住所の欄）が残っているかを出す。本文は出さない（欄の有無だけ）。
//   使い方: npx tsx --env-file=<.env.local> scripts/audit-contract-doc-images.ts
import { createClient } from "@supabase/supabase-js";
import { CONTRACT_DOC_RE, savedImageKind } from "../app/lib/image-label";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
async function main() {
  const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, image_type, text").eq("sender", "customer").like("text", "[画像]%")
    .or("text.ilike.%契約書%,text.ilike.%アシストレント%,text.ilike.%保証委託契約%,text.ilike.%申込書%,text.ilike.%同意書%").order("created_at").limit(2000);
  if (error) throw new Error(error.message);
  let hit = 0, piiLeft = 0;
  for (const r of (data ?? []) as Array<{ id: string; conversation_id: string; created_at: string; image_type: string | null; text: string }>) {
    if (!r.text.includes("\n") && r.text.length < 60) continue;
    const t = r.text.normalize("NFKC");
    const m = CONTRACT_DOC_RE.test(t);
    const fields = ["氏名", "住所", "生年月日", "勤務先", "電話", "借主", "契約者", "連帯保証人"].filter((f) => t.includes(f));
    const words = ["アシストレント", "保証委託契約", "賃貸借契約書", "保証契約書", "駐車場使用契約書", "申込書", "同意書", "契約書", "重要事項説明書", "見積"].filter((w) => t.includes(w));
    if (m) hit++;
    if (m && fields.length) piiLeft++;
    console.log(`${m ? "当たる" : "外れ "} ${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 10)} ${r.image_type ?? "-"} 見出し=${savedImageKind(r.text) ?? "なし"} 語=[${words.join(",")}] 欄=[${fields.join(",")}] id=${r.id}`);
  }
  console.log(`網に当たる ${hit}・そのうち氏名・住所等の欄が本文に残る ${piiLeft}（消す・伏せるのは統括役に知らせてから）`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
