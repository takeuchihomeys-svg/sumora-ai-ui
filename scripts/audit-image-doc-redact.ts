// scripts/audit-image-doc-redact.ts — 読むだけ・LLM なし（2026-11-15 作業員H）
//   読む時の置き換え（image-doc-redact・IMAGE_DOC_READ_REDACT）と出口の網（alt-pii-gate の ALT_IMAGE_DOC_GATE）が当たる行を、
//   会話の本文の「[画像]」始まりの全期間の行（お客様・スタッフとも）で数える。当たった行は型・送り手・見出しだけ出す（本文は出さない）。
//   誤って止める物（物件の資料・弊社の見積書の金額だけ・スタッフの送信）が無いかを目で読む。
//   使い方: npx tsx --env-file=<.env.local> scripts/audit-image-doc-redact.ts
import { createClient } from "@supabase/supabase-js";
import { imageDocHit } from "../app/lib/image-doc-redact";
import { savedImageKind } from "../app/lib/image-label";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
async function main() {
  let n = 0; const by = new Map<string, number>();
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, sender, image_type, text").like("text", "[画像]%").order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ id: string; conversation_id: string; created_at: string; sender: string; image_type: string | null; text: string }>) {
      n++;
      const h = imageDocHit(r.text);
      if (!h) continue;
      const k = `${h}/${r.sender}`; by.set(k, (by.get(k) ?? 0) + 1);
      console.log(`${h} ${r.sender} ${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 16)} ${r.image_type ?? "-"} 見出し=${savedImageKind(r.text) ?? "なし"} id=${r.id}`);
    }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`「[画像]」の行 ${n}・当たる ${[...by].map(([k, v]) => `${k} ${v}`).join("・") || "0"}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
