// scripts/audit-r11-takeuchi-style.ts — 11巡目: 竹内さんの手打ちの返信（messages.staff_writer='takeuchi'・AIX でない・③報告でない）の書き方の形を
//   小場面ごとに数える（＝正解の多数派）。あわせて同じ小場面の本番の下書き（r11-table-prod.jsonl）の率を並べる（読むだけ・LLM なし）
//   形は scripts/lib/r8-style-targets.styleTargets（何卒・締めの何卒・開口語の後の空行・かしこまりましたで始める・はいで始める・開口語の絵文字・行末の絵文字の後の！！ 等）
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-takeuchi-style.ts [--days=120] [--min=8] [--keys=nanitozo,kashikoStart]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { isStaffOnlyReport } from "../app/lib/text-diff-types";
import { subSceneOf } from "../app/lib/reply-subscene";
import { styleTargets, STYLE_JA, type StyleKey } from "./lib/r8-style-targets";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120"));
const MIN = Number(arg("min", "8"));
const KEYS = arg("keys", "nanitozo,nanitozoLast,openerBlank,kashikoStart,haiStart,openerEmoji,emojiThenBang,greeting,anyEmoji").split(",") as StyleKey[];
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type Msg = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", since).order("created_at").order("id").range(f, t));
  const ap = await readAll<{ conversation_id: string; created_at: string }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").order("created_at").range(f, t));
  const applied = new Map<string, number>(); for (const a of ap) if (!applied.has(a.conversation_id)) applied.set(a.conversation_id, Date.parse(a.created_at));
  const by = new Map<string, Msg[]>(); for (const m of msgs) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const stat = new Map<string, { n: number; v: Record<string, [number, number]> }>();
  let n = 0;
  for (const [cid, list] of by) {
    if (isTestConversation(cid)) continue;
    for (let i = 1; i < list.length; i++) {
      const m = list[i];
      // 返事のまとまりの最初の手打ち（直前がお客様）
      if (m.sender !== "staff" || m.is_aix_generated || m.staff_writer !== "takeuchi" || list[i - 1].sender !== "customer") continue;
      const tx = (m.text ?? "").trim(); if (!tx || /^\[(?:画像|動画|スタンプ)\]$/.test(tx) || isStaffOnlyReport(tx)) continue;
      const a = applied.get(cid); if (a && a <= Date.parse(m.created_at)) continue;
      let j = i - 1; const cust: string[] = []; while (j >= 0 && list[j].sender === "customer") { cust.unshift(list[j].text ?? ""); j--; }
      while (j >= 0 && (list[j].sender === "customer" || !(list[j].text ?? "").trim() || /^\s*\[(?:画像|動画|スタンプ)\]\s*$/.test(list[j].text ?? ""))) j--;
      const sub = subSceneOf({ customerText: cust.join("\n"), prevStaffText: j >= 0 ? list[j].text ?? "" : "" });
      const st = styleTargets(tx);
      for (const key of [sub, sub.split(":")[0], "全体"]) {
        const s = stat.get(key) ?? { n: 0, v: {} }; s.n++;
        for (const k of KEYS) { const x = st[k]; if (x === null) continue; const c = s.v[k] ?? [0, 0]; c[1]++; if (x) c[0]++; s.v[k] = c; }
        stat.set(key, s);
      }
      n++;
    }
  }
  // 本番の下書き（同じ小場面・語の場面）
  const draftStat = new Map<string, Record<string, [number, number]>>();
  if (existsSync("scripts/.replay-out/r11-table-prod.jsonl")) {
    for (const l of readFileSync("scripts/.replay-out/r11-table-prod.jsonl", "utf8").trim().split("\n")) {
      const r = JSON.parse(l) as { subWord: string; draft: string; staff: string };
      if (r.draft.trim() === r.staff.trim()) continue;
      const st = styleTargets(r.draft);
      for (const key of [r.subWord, r.subWord.split(":")[0], "全体"]) {
        const v = draftStat.get(key) ?? {};
        for (const k of KEYS) { const x = st[k]; if (x === null) continue; const c = v[k] ?? [0, 0]; c[1]++; if (x) c[0]++; v[k] = c; }
        draftStat.set(key, v);
      }
    }
  }
  console.log(`竹内さんの手打ちの返信 ${n}通（${DAYS}日・まとまりの最初の通・申込以降と③を除く）。各欄＝竹内さん％(n)／下書き％（直した下書きだけ・40日）`);
  console.log(["小場面", "n", ...KEYS.map((k) => STYLE_JA[k])].join(" | "));
  const pc = (c?: [number, number]) => (c && c[1] ? `${Math.round((100 * c[0]) / c[1])}` : "-");
  for (const [k, s] of [...stat.entries()].filter(([, s]) => s.n >= MIN).sort((a, b) => a[0].localeCompare(b[0]))) {
    const d = draftStat.get(k) ?? {};
    console.log([k, s.n, ...KEYS.map((key) => `${pc(s.v[key])}(${s.v[key]?.[1] ?? 0})/${pc(d[key])}`)].join(" | "));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
