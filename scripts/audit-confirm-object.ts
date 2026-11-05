// scripts/audit-confirm-object.ts — 確認の対象（findConfirmObject）を CONFIRM_OBJECT_ALL の off/on で本番の確認の約束の番に当て、変わる番を並べる（読むだけ・LLM なし）
// 2026-11-06 作業員9（弱い所 346）。過去 N 日のこちらの「確認させて頂きます」の直前のお客様の発言（同じ会話・その前の通）に当てる。営業時間外に流す
// 実行: npx tsx --env-file=.env.local scripts/audit-confirm-object.ts [--days=90] [--show=40]
import { createClient } from "@supabase/supabase-js";
import { findConfirmObject } from "../app/lib/confirmation-context";
import { normalizeCustomerText } from "../app/lib/reply-context";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const DAYS = Number(arg("days", "90")), SHOW = Number(arg("show", "40"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const staff: M[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer").eq("sender", "staff")
      .gte("created_at", since).like("text", "%確認させて%").order("created_at").range(from, from + 999);
    if (error) throw error;
    staff.push(...((data ?? []) as M[]));
    if (!data || data.length < 1000) break;
  }
  let n = 0, changed = 0; const rows: string[] = []; const byPair = new Map<string, number>();
  for (const s of staff) {
    const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", s.conversation_id).lt("created_at", s.created_at).order("created_at", { ascending: false }).limit(4);
    // 本番と同じく、お客様が書いた言葉だけで見る（画像の読み取り文は除く＝resolveConfirmationContext と同じ normalizeCustomerText）
    const cust = normalizeCustomerText((data ?? []).filter((m) => m.sender === "customer").map((m) => m.text ?? "").reverse().join("\n"));
    if (!cust.trim()) continue;
    n++;
    const off = findConfirmObject(cust, {}), on = findConfirmObject(cust, { CONFIRM_OBJECT_ALL: "on" });
    if (off !== on) {
      changed++; const k = `${off} → ${on}`; byPair.set(k, (byPair.get(k) ?? 0) + 1);
      if (rows.length < SHOW) rows.push(`- ${s.created_at.slice(0, 10)} ${s.staff_writer ?? "?"}｜${off} → ${on}\n   客: ${cust.replace(/\s+/g, " ").slice(0, 120)}\n   送: ${(s.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  console.log(`過去${DAYS}日のこちらの確認の約束 ${staff.length}通・直前のお客様の発言あり ${n}番・中身が変わる ${changed}番`);
  for (const [k, v] of [...byPair].sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`);
  console.log(rows.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
