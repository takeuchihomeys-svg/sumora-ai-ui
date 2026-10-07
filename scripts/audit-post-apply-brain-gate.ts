// scripts/audit-post-apply-brain-gate.ts — 申込中・審査中のお客様の番に post-apply-brain-gate を当て、回す番・回さない番を読む（読むだけ・LLM なし）
//   2026-10-07 竹内さんの決定「申込中・審査中は否決・取り消し・クレームの時だけブレインを回す」の語の線を実データで確かめる。
//   申込中の番の取り方（status の履歴が無いので近似）: AIX【申込へ】の押下の後・申込前に戻した時刻（conversations.deepseek_cutoff_at）より前のお客様の連投。
//   出す物: 回す番の理由ごとの数と実文（誤って回す側＝費用だけ）／回さない番のうち気になる語（やっぱ・考え・他の・落ち・不安 等）を含む実文（取りこぼしの候補）
// 実行: npx tsx --env-file=.env.local scripts/audit-post-apply-brain-gate.ts [--days=180] [--show-run=40] [--show-skip=80]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { decidePostApplyBrainGate, type GateMsg } from "../app/lib/post-apply-brain-gate";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const SHOW_RUN = Number(arg("show-run", "40"));
const SHOW_SKIP = Number(arg("show-skip", "80"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 500_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; await sleep(200); } return out;
}
const WATCH_RE = /やっぱ|考え|他の|別の|落ち|ダメ|だめ|無理|やめ|止め|断|不安|遅い|連絡(?:が)?(?:ない|来ない|こない)|おかしい|困|違う|解約|見送|保留|待って|延期|否|不可|厳し/;
type M = GateMsg & { conversation_id: string };
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const pushes = await readAll<{ conversation_id: string; created_at: string }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").gte("created_at", since).order("created_at").range(f, t));
  const convIds = [...new Set(pushes.map((p) => p.conversation_id).filter((c) => !isTestConversation(c)))];
  const cutoff = new Map<string, string | null>();
  const msgs: M[] = [];
  for (let i = 0; i < convIds.length; i += 50) {
    const ids = convIds.slice(i, i + 50);
    const { data: cs } = await sb.from("conversations").select("id, deepseek_cutoff_at").in("id", ids);
    for (const c of (cs ?? []) as Array<{ id: string; deepseek_cutoff_at: string | null }>) cutoff.set(c.id, c.deepseek_cutoff_at);
    msgs.push(...await readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", ids).gte("created_at", since).order("created_at").order("id").range(f, t)));
  }
  const by = new Map<string, M[]>(); for (const m of msgs) (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  const pBy = new Map<string, string[]>(); for (const p of pushes) (pBy.get(p.conversation_id) ?? pBy.set(p.conversation_id, []).get(p.conversation_id)!).push(p.created_at);
  const reasons = new Map<string, number>();
  const runShows: string[] = [], skipShows: string[] = [];
  let turns = 0, run = 0, skipWatch = 0;
  for (const cid of convIds) {
    const ms = by.get(cid) ?? []; const ps = (pBy.get(cid) ?? []).sort();
    const cut = cutoff.get(cid) ?? null;
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || (i > 0 && ms[i - 1].sender === "customer")) continue;
      let j = i; while (j + 1 < ms.length && ms[j + 1].sender === "customer") j++;
      const end = ms[j].created_at;
      const push = ps.filter((p) => p <= end).pop() ?? null;
      if (!push) continue;
      // 申込の後に申込前へ戻した（戻しが押下より後で番より前）＝切り替えの期間（関門の外）
      if (cut && cut > push && cut <= end) continue;
      turns++;
      const window = ms.slice(Math.max(0, j - 39), j + 1);
      const g = decidePostApplyBrainGate({ status: "applying", msgs: window, applicationPushAt: push, env: {} });
      const turn = ms.slice(i, j + 1).map((m) => m.text ?? "").join(" ⏎ ");
      const key = g.reason.replace(/:.*$/, "");
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
      if (g.run) { run++; if (runShows.length < SHOW_RUN && key !== "after_staff_fail" && key !== "after_own_fail") runShows.push(`[${g.reason}] ${cid.slice(0, 8)} ${end.slice(0, 16)} 客「${turn.slice(0, 90)}」`); }
      else if (WATCH_RE.test(turn.replace(/\[画像\][^⏎]*/g, ""))) { skipWatch++; if (skipShows.length < SHOW_SKIP) skipShows.push(`${cid.slice(0, 8)} ${end.slice(0, 16)} 客「${turn.slice(0, 110)}」`); }
    }
  }
  console.log(`申込中の番（近似・${DAYS}日・会話 ${convIds.length}）${turns}: 回す ${run}（${Math.round((run / Math.max(1, turns)) * 100)}%）・回さない ${turns - run}（うち気になる語 ${skipWatch}）`);
  for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log("\n■ 回す番（語で当たった物・否決の後の番は除く）"); for (const s of runShows) console.log("  " + s);
  console.log("\n■ 回さない番で気になる語を含む物（取りこぼしの候補）"); for (const s of skipShows) console.log("  " + s);
})().catch((e) => { console.error(e); process.exit(1); });
