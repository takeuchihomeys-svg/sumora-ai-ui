// scripts/backfill-estimate-card-costs.ts — 見積の記録（estimate_records）の金額の空の行を、一緒に送った見積の札の文で埋める（LLM なし）
// 2026-11-14 作業員G。決まりは app/lib/estimate-card-fill.ts（純関数）。既定は下見だけ（書かない）。
// 実行: npx tsx --env-file=.env.local scripts/backfill-estimate-card-costs.ts [--days=30] [--apply] [--show]
//   読む量: 金額の空の行（日数の内）→ ログごとに1回 messages（その会話・ログの3分前〜1分後・AIX の通だけ）。JST 9〜22時でも軽い（ログの数だけ）。
//   書く量: 埋まった行だけ initial_cost_yen・discount_yen（discount は空の時だけ）を update。
import { createClient } from "@supabase/supabase-js";
import { cardCostsOf, fillItemsFromCards, ESTIMATE_CARD_RE } from "../app/lib/estimate-card-fill";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

type Row = { id: string | number; aix_usage_log_id: string | null; conversation_id: string; property_name: string | null; room_no: string | null; discount_yen: number | null; initial_cost_yen: number | null; source: string | null; created_at: string; estimated_at: string | null };

async function main() {
  const days = Number(arg("days", "30"));
  const apply = process.argv.includes("--apply");
  const show = process.argv.includes("--show");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await sb.from("estimate_records").select("id, aix_usage_log_id, conversation_id, property_name, room_no, discount_yen, initial_cost_yen, source, created_at, estimated_at")
    .is("initial_cost_yen", null).gte("created_at", since).order("created_at").limit(2000);
  if (error) throw error;
  const rows = ((data ?? []) as Row[]).filter((r) => r.property_name);
  const byLog = new Map<string, Row[]>();
  for (const r of rows) { const k = r.aix_usage_log_id ?? String(r.id); byLog.set(k, [...(byLog.get(k) ?? []), r]); }
  let filled = 0, logsWithCard = 0;
  const bySource: Record<string, { rows: number; filled: number }> = {};
  for (const [, rs] of byLog) {
    const at = Date.parse(rs[0].estimated_at ?? rs[0].created_at);
    const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", rs[0].conversation_id).eq("is_aix_generated", true)
      .gte("created_at", new Date(at - 3 * 60_000).toISOString()).lte("created_at", new Date(at + 60_000).toISOString()).limit(40);
    const texts = ((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").filter((t) => ESTIMATE_CARD_RE.test(t.normalize("NFKC")));
    if (texts.length) logsWithCard++;
    const items = rs.map((r) => ({ id: r.id, source: r.source ?? "?", propertyName: r.property_name ?? "", roomNo: r.room_no, discountYen: r.discount_yen, initialCostYen: r.initial_cost_yen }));
    const f = fillItemsFromCards(items, cardCostsOf(texts));
    for (const it of f.items) {
      const s = (bySource[it.source] ??= { rows: 0, filled: 0 });
      s.rows++;
      if (it.initialCostYen == null) continue;
      s.filled++; filled++;
      if (show) console.log(`  ${it.source.padEnd(13)} ${String(it.id).slice(0, 8)} 初期 ${it.initialCostYen} 割 ${it.discountYen ?? "-"}`);
      if (apply) {
        const { error: e2 } = await sb.from("estimate_records").update({ initial_cost_yen: it.initialCostYen, ...(rs.find((r) => r.id === it.id)?.discount_yen == null && it.discountYen != null ? { discount_yen: it.discountYen } : {}) }).eq("id", it.id).is("initial_cost_yen", null);
        if (e2) console.warn(`  書けなかった ${String(it.id).slice(0, 8)}: ${e2.message}`);
      }
    }
  }
  console.log(`直近${days}日 金額の空の行 ${rows.length}（ログ ${byLog.size}・札の文があったログ ${logsWithCard}）→ 埋まる行 ${filled}${apply ? "（書いた）" : "（下見・--apply で書く）"}`);
  for (const [k, v] of Object.entries(bySource)) console.log(`  ${k.padEnd(13)} ${v.filled}/${v.rows}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
