// YUMA（テスト用会話）の現状を控える／戻す（設計知見「テスト用の会話でも元の値を控えて戻す」）
// 使い方: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts save|restore|show
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const FILE = "scripts/.yuma-backup.json";
// 2026-09-23: brain_strategy（会話全体の戦略）も控える（戦略の作り直しのテストで書くため）
// 2026-09-23: property_customer_id も控える。場面再現のテストで YUMA が**別のお客様の登録（property_customers）**に紐付き、
//   希望条件の「顧客名: 〇〇」として本名が DeepSeek 経路の下書きに出た。戻す時に紐付きも元（null）へ戻す
const COLS = "id, customer_name, status, ai_draft, ai_draft_check, suggested_aix_meta, last_brain_meta, brain_analyzed_at, brain_strategy, draft_pending_at, draft_attempted_at, last_message, last_sender, property_customer_id, updated_at";

async function main() {
  const cmd = process.argv[2] ?? "show";
  const { data } = await sb.from("conversations").select(COLS).eq("id", YUMA).maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;

  if (cmd === "save") {
    writeFileSync(FILE, JSON.stringify(row, null, 2), "utf8");
    console.log(`控えた: ${FILE}`);
    console.log(`  status=${row.status} ai_draft=${String(row.ai_draft ?? "(なし)").slice(0, 40)}`);
    return;
  }
  if (cmd === "restore") {
    if (!existsSync(FILE)) { console.log("控えが無い"); return; }
    const b = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
    const { id: _id, customer_name: _n, updated_at: _u, ...rest } = b;
    void _id; void _n; void _u;
    const { error } = await sb.from("conversations").update(rest).eq("id", YUMA);
    console.log(error ? `⚠ 戻せない: ${error.message}` : "元に戻した");
    return;
  }
  // show
  console.log(`=== YUMA の現状 ===`);
  for (const [k, v] of Object.entries(row)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    console.log(`  ${k.padEnd(20)} ${String(s ?? "").replace(/\n/g, " ").slice(0, 100)}`);
  }
  const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(10);
  console.log(`\n--- 直近10通（新→古）---`);
  for (const m of ((ms ?? []) as unknown as Array<Record<string, unknown>>)) {
    console.log(`  [${String(m.created_at).slice(5, 16)} ${m.sender === "customer" ? "客" : "店"}${m.is_aix_generated ? "/AIX" : ""}] ${String(m.text ?? "").replace(/\n/g, " ").slice(0, 78)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
