// 一時: 命令が終わるまで待つ（テスト用・コミットしない）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const id = process.argv[2];
async function main() {
  const t0 = Date.now();
  while (Date.now() - t0 < 25 * 60 * 1000) {
    const { data } = await sb.from("automation_commands").select("status").eq("id", id).maybeSingle();
    const s = (data as { status?: string } | null)?.status;
    if (s && s !== "pending" && s !== "running") { console.log("終わり:", s, Math.round((Date.now() - t0) / 1000) + "秒"); return; }
    await new Promise((r) => setTimeout(r, 20000));
  }
  console.log("25分たっても終わらない");
}
main();
