// 会話1件の中身を見る（読み取りのみ・個人情報はマスキング）
// 実行: npx tsx --env-file=.env.local scripts/peek-one-conversation.ts --id=<conversation_id> [--n=20]
//       npx tsx --env-file=.env.local scripts/peek-one-conversation.ts --name=名称未設定
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉").replace(/0\d{1,3}-?\d{2,4}-?\d{4}/g, "〈電話〉");

async function main() {
  let id = arg("id");
  if (!id) {
    const name = arg("name", "名称未設定");
    const { data } = await sb.from("conversations").select("id, customer_name, created_at")
      .eq("customer_name", name).order("created_at", { ascending: false }).limit(1);
    id = String(((data ?? [])[0] as { id?: string } | undefined)?.id ?? "");
    if (!id) { console.log("会話が見つからない"); return; }
  }
  const { data: conv } = await sb.from("conversations").select("*").eq("id", id).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  console.log("=== conversations ===");
  for (const k of ["id", "customer_name", "line_user_id", "account", "status", "line_status", "created_at", "updated_at", "last_sender", "property_customer_id"]) {
    console.log(`  ${k}: ${String(c[k] ?? "(なし)")}`);
  }
  const n = Number(arg("n", "20"));
  const { data: msgs } = await sb.from("messages")
    .select("sender, text, image_url, line_message_id, quoted_message_id, created_at")
    .eq("conversation_id", id).order("created_at", { ascending: false }).limit(n);
  console.log(`\n=== 直近${n}件（古い順）===`);
  for (const m of ((msgs ?? []) as Array<Record<string, unknown>>).reverse()) {
    console.log(`[${String(m.sender)} ${String(m.created_at).slice(5, 16)}] ${mask(String(m.text ?? "")).replace(/\n/g, " ").slice(0, 90)}${m.image_url ? " 🖼" : ""}${m.quoted_message_id ? " 💬引用" : ""}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
