// 「2番手で申込中（並行で探す）」の判定を1つにした前後の比べ（読み取りのみ・LLM なし・DB に書かない・会話ID 先頭8桁と伏せた文だけ）
//
// 2026-10-21: 旧は2つの判定があった
//   旧A ハブ（customer-hub の rankWaiting）: 申込前の status ＋ 30日以内のスタッフの文に「2〜9番手／繰り上が」（「1番手」を含む文は除く）
//   旧B parallel-second（post-apply.parallelSecondActive）: 今も申込中 ＋ スタッフの選択／2番手で申込んだ文／ピッカー＋案内
//   新: ハブ・やることリスト・司令塔・申込歴ありの札も post-apply.judgeParallelSecond（戻した会話も入る・案内は数えない）
//   B はこのコードの判定（1つにする前のコミットでは 1会話＝99de254a・1つにした後は 2会話＝a3cc571e が加わる）。2026-10-21 120日・候補81会話で測った
// 実行: npx tsx --env-file=.env.local scripts/audit-parallel-unify.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
import { loadPostApplyFacts, parallelSecondActive, resolvePostApply } from "../app/lib/post-apply";
import { loadReapplyInfo } from "../app/lib/reapply-customer-server";
import { getCustomerHub } from "../app/lib/customer-hub-server";
import { conductCustomer } from "../app/lib/link-conductor";
import { RANK_WAITING_RE } from "../app/lib/parallel-search";
import { isPreApplyForNudge } from "../app/lib/apply-stage-nudge";
import { maskPII } from "../app/lib/pii-mask";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const id8 = (s: string) => s.slice(0, 8);
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 120);
const NOW = Date.now();
const DAY = 86_400_000;

async function main() {
  const since = new Date(NOW - days * DAY).toISOString();
  // 候補: 期間内に「番手・繰り上」を含む通がある会話 ＋ 今 申込中の status の会話
  const cand = new Set<string>();
  for (let a = 0; ; a += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").gte("created_at", since).or("text.ilike.%番手%,text.ilike.%繰り上%").order("id").range(a, a + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) cand.add(r.conversation_id as string);
    if (!data || data.length < 1000) break;
  }
  const { data: ap, error: apErr } = await sb.from("conversations").select("id").in("status", ["applying", "application", "screening"]);
  if (apErr) throw new Error(apErr.message);
  for (const r of ap ?? []) cand.add(r.id as string);
  const ids = [...cand].filter((id) => !isTestConversation(id));
  console.log(`候補 ${ids.length} 会話（${days}日に番手・繰り上の通がある＋今 申込中の status）`);

  const oldHub: string[] = [], oldPar: string[] = [], failed: string[] = [];
  const hubPar: string[] = [], reap: string[] = [], movedBackPar: string[] = [], conductorClosed: string[] = [];
  const ex: Record<string, string> = {};
  const statusOf: Record<string, string> = {};
  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try {
        const { data: c } = await sb.from("conversations").select("status, customer_name").eq("id", id).maybeSingle();
        const status = (c?.status as string | null) ?? null;
        statusOf[id] = status ?? "-";
        const { data: ms } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", id).gte("created_at", new Date(NOW - 30 * DAY).toISOString()).neq("sender", "customer").or("text.ilike.%番手%,text.ilike.%繰り上%").order("created_at");
        const hit = (ms ?? []).find((m) => { const t = String(m.text ?? "").normalize("NFKC"); return RANK_WAITING_RE.test(t) && !/1番手/.test(t); });
        if (isPreApplyForNudge(status) && hit) {
          oldHub.push(id);
          const t = String(hit.text ?? "");
          const s = t.split(/[\n。]/).find((x) => /番手|繰り上/.test(x)) ?? t;
          ex[id] = maskPII(s.trim(), [c?.customer_name as string | null]).slice(0, 60);
        }
        const f = await loadPostApplyFacts(sb, id);
        if (parallelSecondActive(f)) {
          oldPar.push(id);
          if (resolvePostApply(f).movedBack || !resolvePostApply(f).postApply) movedBackPar.push(id);
          if (await loadReapplyInfo(sb, id, f)) reap.push(id);
          const h = await getCustomerHub(sb, id);
          if (h?.hub.flags.parallelSecond === true) hubPar.push(id);
          if (h && conductCustomer(h.hub, h.contradictions, h.input).reader === "closed") conductorClosed.push(id);
        }
      } catch (e) { failed.push(`${id8(id)}:${e instanceof Error ? e.message.slice(0, 40) : e}`); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const both = oldHub.filter((x) => oldPar.includes(x));
  console.log(`旧A ハブ rankWaiting: ${oldHub.length}・B parallel-second（このコードの判定）: ${oldPar.length}・両方: ${both.length}・読めない: ${failed.length}`);
  console.log(`食い違い: Aだけ ${oldHub.length - both.length}・Bだけ ${oldPar.length - both.length}`);
  for (const id of oldHub.filter((x) => !oldPar.includes(x)).slice(0, 15)) console.log(`  Aだけ ${id8(id)} status=${statusOf[id]}「${ex[id] ?? ""}」`);
  for (const id of oldPar.filter((x) => !oldHub.includes(x)).slice(0, 15)) console.log(`  Bだけ ${id8(id)} status=${statusOf[id]}`);
  if (failed.length) console.log(`  読めない: ${failed.slice(0, 5).join(" / ")}`);
  console.log(`（このコードの判定）2番手で申込中 ${oldPar.length} 会話: うち戻した会話 ${movedBackPar.length}・ハブも同じ ${hubPar.length}・申込歴ありの札が付く ${reap.length}・司令塔が申込以降で止める ${conductorClosed.length}`);
  for (const id of oldPar) console.log(`  ${id8(id)} status=${statusOf[id]}${movedBackPar.includes(id) ? "・戻した会話" : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
