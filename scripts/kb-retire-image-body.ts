// 設計知見「物件資料の PDF は画像にして…お客様へ画像→本文の順で送れる」を非現行にする（2026-09-24 夜・説明文がお客様に届いた件）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data, error } = await sb.from("system_design_thinking").update({ is_current: false })
    .like("title", "物件資料の PDF は「画像にして」DeepSeek に読ませる%").eq("is_current", true).select("id, title");
  console.log(error ? `失敗: ${error.message}` : `非現行にした: ${(data ?? []).length}件 ${(data ?? []).map((r) => r.title.slice(0, 40)).join(" / ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
