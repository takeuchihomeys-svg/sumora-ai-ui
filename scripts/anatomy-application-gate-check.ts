// scripts/anatomy-application-gate-check.ts — 文の解剖で外の LLM に渡した番（roles-*.json）のうち、申込以降の番が何通あったか数える（LLM なし・DB は読むだけ）
//   2026-11-11 作業員5。門は app/lib/turn-application-gate.ts（その番の時刻で申込の記録を引き直す）。1会話ずつ・間を空けて引く（全件は読まない）。
// 実行: npx tsx --env-file=<サーバーの鍵のある .env> scripts/anatomy-application-gate-check.ts [--file=roles-r1.json]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(process.cwd(), "..", "..", "exam-cache");
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { loadTurnApplicationRecords } = await import("../app/lib/turn-application-gate-server");
  const { turnApplicationReason } = await import("../app/lib/turn-application-gate");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const out = JSON.parse(readFileSync(join(CACHE, "anatomy-roles", arg("file", "roles-r1.json")), "utf8")) as Array<{ id: string; scene: string }>;
  const ids = out.map((o) => o.id);
  const msg = new Map<string, { conv: string; at: string }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at").in("id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as Array<{ id: string; conversation_id: string; created_at: string }>) msg.set(String(m.id), { conv: m.conversation_id, at: m.created_at });
  }
  const recs = new Map<string, Awaited<ReturnType<typeof loadTurnApplicationRecords>>>();
  for (const c of [...new Set([...msg.values()].map((m) => m.conv))]) { recs.set(c, await loadTurnApplicationRecords(sb, c)); await sleep(120); }
  const hit: Record<string, number> = {};
  for (const o of out) {
    const m = msg.get(o.id);
    const r = m ? turnApplicationReason(recs.get(m.conv), m.at) : "通が見つからない";
    if (!r) continue;
    const k = r.replace(/（.*）/, "");
    hit[k] = (hit[k] ?? 0) + 1;
    console.log(`  ${o.id.slice(0, 8)} ${o.scene}: ${r}`);
  }
  console.log(`# 申込以降の疑いで外す番: ${Object.values(hit).reduce((a, b) => a + b, 0)}/${out.length}通 ${JSON.stringify(hit)}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
