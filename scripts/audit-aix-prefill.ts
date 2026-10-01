// AIX の物件名の先入れ（app/lib/aix-prefill.ts propertyNamePrefill）が、スタッフが実際に入れた物件名と合うかの監査（読み取りのみ・LLM なし）
// 2026-10-01 竹内「AIX 開いたら、確認した要件以外は全てセットされていて…物件名等はセットされていて」
//   正解: aix_usage_logs.property_names（物件確認した でスタッフが入れた物件名）。押す前の会話（直近20通＝画面の recentMessages と同じ幅）で当てる
//   数える: 当たり（建物名が同じ）／外れ（別の物件を入れる＝取り違え）／空（決まらない＝今まで通り候補ボタン）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-prefill.ts   （DAYS=180・SHOW=10）
import { createClient } from "@supabase/supabase-js";
import { propertyNamePrefill, propertyBaseName, customerTurnOf } from "../app/lib/aix-prefill";
import { customerSharedPropertyNames } from "../app/lib/customer-property-names";
import { extractPropertyLabels } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const SHOW = Number(process.env.SHOW ?? 10);

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const { data: logs, error } = await sb.from("aix_usage_logs").select("id, conversation_id, created_at, check_pattern, property_names")
    .gte("created_at", since).not("property_names", "is", null).neq("conversation_id", YUMA).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const tally: Record<string, number> = { hit: 0, wrong: 0, empty: 0 };
  const bySrc: Record<string, { hit: number; wrong: number }> = {};
  const ex: string[] = [];
  for (const l of (logs ?? []) as Array<{ conversation_id: string; created_at: string; check_pattern: string | null; property_names: string[] }>) {
    const truth = (l.property_names ?? []).map(propertyBaseName).filter(Boolean);
    if (!truth.length) continue;
    const { data: ms } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", l.conversation_id)
      .lt("created_at", l.created_at).order("created_at", { ascending: false }).limit(20);
    const msgs = ((ms ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).reverse().map((m) => ({ sender: m.sender, text: m.text ?? "", rawCreatedAt: m.created_at }));
    const turn = customerTurnOf(msgs);
    const turnStart = turn[0] ? Date.parse(turn[0].rawCreatedAt) : NaN;
    const shared = customerSharedPropertyNames(msgs).filter((c) => Number.isFinite(turnStart) && c.at && Date.parse(c.at) >= turnStart).map((c) => c.name);
    const staffSent: string[] = [];
    for (const m of [...msgs].reverse()) { if (m.sender === "customer") continue; for (const n of extractPropertyLabels(m.text)) if (!staffSent.includes(n)) staffSent.push(n); }
    const p = propertyNamePrefill({ customerSharedThisTurn: shared, staffSent, customerTurnText: turn.map((m) => m.text).join("\n") });
    if (!p) { tally.empty++; continue; }
    const b = propertyBaseName(p.value);
    const ok = truth.some((tr) => tr === b || tr.includes(b) || b.includes(tr));
    tally[ok ? "hit" : "wrong"]++;
    (bySrc[p.source] ??= { hit: 0, wrong: 0 })[ok ? "hit" : "wrong"]++;
    if (!ok && ex.length < SHOW) ex.push(`  [${l.check_pattern}] 入れた: ${p.value}（${p.source}）／スタッフ: ${l.property_names.join("・")}`);
  }
  const n = tally.hit + tally.wrong + tally.empty;
  console.log(`物件確認した（物件名の記録あり）${n}件: 当たり ${tally.hit}・外れ ${tally.wrong}・空（候補ボタンのまま） ${tally.empty}`);
  for (const [s, v] of Object.entries(bySrc)) console.log(`  ${s}: 当たり ${v.hit}・外れ ${v.wrong}`);
  console.log("\n外れの実物:");
  for (const e of ex) console.log(e);
}
main().catch((e) => { console.error(e); process.exit(1); });
