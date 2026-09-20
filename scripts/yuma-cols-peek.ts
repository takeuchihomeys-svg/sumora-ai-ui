// conversations の下書き関連カラムを確認（読み取りのみ）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const { data, error } = await sb.from("conversations").select("*").eq("id", YUMA).maybeSingle();
  if (error) { console.log("error:", error.message); return; }
  const row = (data ?? {}) as Record<string, unknown>;
  const keys = Object.keys(row).filter((k) => /draft|aix|sender|status/i.test(k));
  console.log("=== 下書き・AIX 関連カラム ===");
  for (const k of keys) {
    const v = row[k];
    const s = v === null ? "null" : typeof v === "object" ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120);
    console.log(`  ${k.padEnd(28)} = ${s.replace(/\n/g, " ／ ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
