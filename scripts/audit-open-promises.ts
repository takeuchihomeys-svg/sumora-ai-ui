// 今開いているお客様への約束（直近14日）を全会話に当てる（読み取りのみ・promise-tracker の全件監査）
// 2026-09-22 竹内「約束を大切に、どれだけ約束しているか。お客さんとの約束のLINE。ここを確認」
// 実行: npx tsx --env-file=.env.local scripts/audit-open-promises.ts
import { createClient } from "@supabase/supabase-js";
import { trackPromises, type OpenPromise } from "../app/lib/promise-tracker";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

async function main() {
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const rows: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }> = [];
  for (let p = 0; p < 30; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  const by = new Map<string, typeof rows>();
  for (const m of rows) { if (m.conversation_id === YUMA) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  let made = 0, kept = 0, convWith = 0;
  const open: Array<OpenPromise & { cid: string; lastCust: string; custAfter: boolean }> = [];
  for (const [cid, arr] of by) {
    const t = trackPromises(arr.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated })));
    made += t.made; kept += t.kept; if (t.made) convWith++;
    const lastCust = [...arr].reverse().find((m) => m.sender === "customer");
    for (const p of t.open) open.push({ ...p, cid, lastCust: (lastCust?.text ?? "").slice(0, 40), custAfter: !!lastCust && lastCust.created_at > p.at });
  }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  console.log(`直近14日: 会話 ${by.size}件・約束のある会話 ${convWith}件 ／ 約束 ${made}件・果たした ${kept}件（${pct(kept, made)}）・まだ ${open.length}件`);
  const st = new Map<string, number>(); for (const o of open) st.set(`${o.kind}/${o.status}`, (st.get(`${o.kind}/${o.status}`) ?? 0) + 1);
  console.log(`内訳: ${[...st.entries()].sort().map(([k, v]) => `${k} ${v}`).join(" ／ ")}`);
  const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様)/g, "〈お客様〉").replace(/\n/g, " ");
  console.log(`\n【遅れ・遅れ気味の実例（目で読む用）】`);
  for (const o of open.filter((x) => x.status !== "期限内").sort((a, b) => b.elapsedH - a.elapsedH).slice(0, 25)) {
    console.log(`  [${o.status}] ${o.kind} ${Math.round(o.elapsedH)}時間前 会話${o.cid.slice(0, 8)}「${mask(o.sentence)}」${o.custAfter ? `／その後のお客様:「${mask(o.lastCust)}」` : "／その後お客様の発言なし"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
