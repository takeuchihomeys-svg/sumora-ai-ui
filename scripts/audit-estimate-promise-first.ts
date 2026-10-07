// scripts/audit-estimate-promise-first.ts — 3巡目（10/07）: 見積の依頼（物件の初期費用を聞かれた番）にスタッフは
//   ①先に約束の手打ち（「御見積書作成しお送り…」）→後で AIX【見積書送る】 ②何も打たずに AIX【見積書送る】だけ ③他 のどれか（読むだけ・LLM なし）
//   2段の決まり（10/02 見積書送る→いつも約束の返信が先）が 10/03〜の道の違い（初期費用の場面 1/8）の出所かを確かめる
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-promise-first.ts [--days=120] [--show] [--brain] [--wording]
//   --brain（10/07 竹内さんの決定「見積の依頼は約束の返信に揃える」の当て直し）: その番のブレインの判断（brain_decision_logs・お客様の最初の通〜スタッフの次の通）と、
//     今のコードの2段（two-stage.resolveTwoStage）を当て直した後の道（約束の返信／AIX のまま）を並べる
//   --wording: スタッフの約束の手打ちの1文（見積の約束の行）を多い順に
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").slice(7));
const SHOW = process.argv.includes("--show");
const BRAIN = process.argv.includes("--brain");
const WORDING = process.argv.includes("--wording");
type B = { conversation_id: string; created_at: string; suggested_action: string | null; decision_source: string | null; conversation_status: string | null };
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type P = { conversation_id: string; aix_type: string; created_at: string };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 1_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const PROMISE_EST_RE = /見積[^\n。！!]{0,20}(?:作成|お送り|ご用意|お出し)|最大限割引[^\n]{0,20}(?:作成|お送り)/;
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, presses] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("conversation_id").order("created_at").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
  ]);
  const pBy = new Map<string, P[]>(); for (const p of presses) (pBy.get(p.conversation_id) ?? pBy.set(p.conversation_id, []).get(p.conversation_id)!).push(p);
  const by = new Map<string, M[]>(); for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const brainBy = new Map<string, B[]>();
  if (BRAIN) {
    const bl = await readAll<B>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action, decision_source, conversation_status").gte("created_at", since).order("created_at").range(f, t));
    for (const b of bl) (brainBy.get(b.conversation_id) ?? brainBy.set(b.conversation_id, []).get(b.conversation_id)!).push(b);
  }
  const { resolveTwoStage } = await import("../app/lib/two-stage");
  const { isPostApplyStatus } = await import("../app/lib/llm-alt-provider");
  const brainTab = new Map<string, number>();
  const brainShows: string[] = [];
  const wording = new Map<string, number>();
  const t = { promiseFirst: 0, aixOnly: 0, other: 0, promiseGapH: [] as number[], aixGapH: [] as number[] };
  const shows: string[] = [];
  for (const [cid, ms] of by) {
    const ps = pBy.get(cid) ?? [];
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || ms[i - 1].sender === "customer") continue;
      let j = i; while (j + 1 < ms.length && ms[j + 1].sender === "customer") j++;
      const turn = ms.slice(i, j + 1).map((x) => x.text ?? "").join("\n");
      if (resolveReplyScene({ customerText: turn }).scene !== "cost") continue;
      if (ps.some((p) => p.aix_type === "application_push" && p.created_at <= ms[j].created_at)) continue;
      // こちらが前に物件を送っている（AIX の物件・資料）か、お客様が物件を指している
      const sentBefore = ps.some((p) => /^(?:property_send|property_recommendation|property_check_result)$/.test(p.aix_type) && p.created_at <= ms[j].created_at);
      if (!sentBefore) continue;
      const next = ms.slice(j + 1).find((x) => x.sender !== "customer");
      const nextCust = ms.slice(j + 1).find((x) => x.sender === "customer");
      const est = ps.find((p) => p.aix_type === "estimate_sheet" && p.created_at > ms[j].created_at && (!nextCust || p.created_at < nextCust.created_at));
      if (!next) continue;
      const gapH = (Date.parse(next.created_at) - Date.parse(ms[j].created_at)) / 3_600_000;
      if (WORDING && !next.is_aix_generated && PROMISE_EST_RE.test(next.text ?? "")) {
        for (const line of (next.text ?? "").split(/\n+/)) if (PROMISE_EST_RE.test(line)) { const k = line.trim(); wording.set(k, (wording.get(k) ?? 0) + 1); }
      }
      if (BRAIN) {
        const staffKind = !next.is_aix_generated && PROMISE_EST_RE.test(next.text ?? "") ? "人=約束" : est && Math.abs(Date.parse(est.created_at) - Date.parse(next.created_at)) < 10 * 60_000 ? "人=AIX" : "人=他";
        const bs = (brainBy.get(cid) ?? []).filter((b) => b.created_at >= ms[i].created_at && b.created_at <= next.created_at);
        const b = bs[bs.length - 1];
        let before = "判断なし", after = "判断なし";
        if (b) {
          const src = (b.decision_source ?? "").replace(/^no_aix:/, "");
          before = b.suggested_action === "estimate_sheet" ? `AIX見積(${src || "?"})` : /two_stage_promise(estimate)/.test(src) ? "約束(見積)" : /two_stage_promise/.test(src) ? `約束(${src})` : b.suggested_action ? `AIX:${b.suggested_action}` : "AIXなし";
          after = before;
          if (b.suggested_action === "estimate_sheet") {
            const v = resolveTwoStage({ finalAix: "estimate_sheet", decisionSource: src || "llm", pickupReady: false, postApply: isPostApplyStatus(b.conversation_status), asksCost: true, customerText: turn });
            after = v ? `約束(${v.kind})` : before;
          }
        }
        const key = `${staffKind}｜前 ${before}｜後 ${after}`;
        brainTab.set(key, (brainTab.get(key) ?? 0) + 1);
        if (SHOW && b && brainShows.length < 80) brainShows.push(`${ms[j].created_at.slice(0, 10)} ${key} 客「${turn.replace(/\n/g, " ").slice(0, 40)}」${staffKind === "人=約束" ? `人「${(next.text ?? "").replace(/\n/g, " / ").slice(0, 60)}」` : ""}`);
      }
      if (!next.is_aix_generated && PROMISE_EST_RE.test(next.text ?? "")) { t.promiseFirst++; t.promiseGapH.push(gapH); if (SHOW && shows.length < 20) shows.push(`約束→ 客「${turn.replace(/\n/g, " ").slice(0, 50)}」人「${(next.text ?? "").replace(/\n/g, " / ").slice(0, 70)}」${gapH.toFixed(1)}h`); }
      else if (est && Math.abs(Date.parse(est.created_at) - Date.parse(next.created_at)) < 10 * 60_000) { t.aixOnly++; t.aixGapH.push(gapH); if (SHOW && shows.length < 40) shows.push(`AIX→ 客「${turn.replace(/\n/g, " ").slice(0, 50)}」${gapH.toFixed(1)}h`); }
      else t.other++;
    }
  }
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1) : "-");
  const n = t.promiseFirst + t.aixOnly + t.other;
  console.log(`初期費用の場面（物件を送った後・申込前・${DAYS}日）${n}番: 先に約束の手打ち ${t.promiseFirst}（中央 ${med(t.promiseGapH)}h）／打たずに AIX【見積書送る】 ${t.aixOnly}（中央 ${med(t.aixGapH)}h）／他 ${t.other}`);
  for (const s of shows) console.log("  " + s);
  if (BRAIN) {
    console.log("\nブレインの判断（前＝その時の記録・後＝今の2段を当て直し）");
    for (const [k, v] of [...brainTab].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
    for (const s of brainShows) console.log("  " + s);
  }
  if (WORDING) {
    console.log("\nスタッフの見積の約束の1文（多い順）");
    for (const [k, v] of [...wording].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
