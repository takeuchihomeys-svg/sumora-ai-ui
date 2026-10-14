// scripts/verify-reading-gate.ts — 本番の経路（reading-gate-server.runReadingGate＝DB をその場で引く・拡大の読み直し）を、保存済みの送った画像の見本で通す
//   （読むだけ・DeepSeek は印の残った画像だけ・llm_usage_logs にも書かない＝本番 DB に書かない）
// 2026-10-14 竹内さん（設計知見 56ecf24a）「自信が無い時だけ深く調べる」
// 実行: npx tsx --env-file=.env.local scripts/verify-reading-gate.ts [--names=トップヒル森河内,栄養グランドハイツ,...]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const names = (process.argv.find((a) => a.startsWith("--names=")) ?? "--names=トップヒル森河内,パレーシャル難波,栄養グランドハイツ,アーネックス御幣筋本町,グランパシフィック木川東").split("=")[1].split(",");

async function main() {
  const { runReadingGate } = await import("../app/lib/reading-gate-server");
  const { fixReadPropertyNameWithLedger } = await import("../app/lib/property-name-ledger-server");
  for (const n of names) {
    const { data } = await sb.from("sent_image_properties").select("image_url, property_name, room_no, source, facts").ilike("property_name", `%${n}%`).not("facts", "is", null).order("created_at", { ascending: false }).limit(5);
    const rows = (data ?? []) as Array<{ image_url: string; property_name: string; room_no: string | null; source: string | null; facts: Record<string, unknown> }>;
    // 印の付く行を先に（同じ建物の別の画像は印が無い事がある）
    const { amountUnitSignals, roomSignals } = await import("../app/lib/reading-confidence");
    const row = rows.find((r) => amountUnitSignals(r.facts, {}).length || roomSignals(r.room_no).length) ?? rows[0];
    if (!row) { console.log(`${n}: 画像なし`); continue; }
    const nf = await fixReadPropertyNameWithLedger(row.property_name);
    const t0 = Date.now();
    const g = await runReadingGate({ imageUrl: row.image_url, nameFix: nf, matched: row.source !== "vision" && row.source !== "backfill_vision", roomNumber: row.room_no, facts: row.facts, recordUsage: false });
    console.log(`${row.property_name} ${row.room_no ?? ""}（${row.source}・名前の直し ${nf.status}）${Date.now() - t0}ms\n   印 ${JSON.stringify(g.signals)} 読み直し ${g.rechecked}\n   名前 ${g.name ? `${g.name.name}（${g.name.rule}）` : "-"}・号室 ${g.room ?? "-"}・facts ${g.facts ? JSON.stringify({ deposit_months: g.facts.deposit_months, deposit_yen: g.facts.deposit_yen, key_money_months: g.facts.key_money_months, key_money_yen: g.facts.key_money_yen, deposit_unit: g.facts.deposit_unit }) : "-"}\n   ${g.log.join(" ｜ ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
