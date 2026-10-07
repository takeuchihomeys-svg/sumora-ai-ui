// scripts/audit-brought-property-promise.ts — お客様が物件を送ってきた（持ち込み）番に、スタッフが最初に何を返したか（読むだけ・LLM なし）
//   2026-10-07 竹内さん（けんじじ 10/7: AI の案「募集状況確認させていただきます」→ スタッフ「2部屋の最大限割引させていただいたお見積書お送りさせていただきます😊！！」）
//   「物件確認のことはLINEから読み取る、募集状況確認の場合と割引の場合あるけど、基本的には募集状況と最大限割引した初期費用の御見積書を両方おくる形」
//   数える物: お客様の言葉（費用だけ／空きだけ／両方／どちらも言っていない）× スタッフの最初の返し（約束の手打ち＝両方・確認だけ・見積だけ／AIX を直接 物件確認した・見積書送る）、件数の言い方
// 実行: npx tsx --env-file=.env.local scripts/audit-brought-property-promise.ts [--days=120] [--show=40] [--check-two-stage]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { broughtPropertyAsk, broughtPropertyCount, resolveTwoStage } from "../app/lib/two-stage";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";
const CHECK2 = process.argv.includes("--check-two-stage");
type B = { conversation_id: string; created_at: string; suggested_action: string | null; decision_source: string | null; conversation_status: string | null };

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120"));
const SHOW = Number(arg("show", "40"));
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type P = { conversation_id: string; aix_type: string; created_at: string };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 1_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const BROUGHT_RE = /https?:\/\/(?:suumo|www\.homes|homes|chintai|www\.chintai|realestate\.yahoo|www\.athome|athome|www\.able|able|www\.minimini|apamanshop|www\.apamanshop|www\.e-heya|www\.shamaison|www\.daito|ieagent|www\.ieagent|canary|www\.mansion-review)|^\[画像\]/m;
const CHECK_P_RE = /(?:募集|空室|空き)状況[^\n。]{0,20}確認|確認[^\n。]{0,10}(?:募集|空室|空き)/;
const EST_P_RE = /見積[^\n。！!]{0,20}(?:作成|お送り|ご用意|お出し)|最大限割引[^\n]{0,30}(?:作成|お送り)/;
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, presses] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("conversation_id").order("created_at").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
  ]);
  const pBy = new Map<string, P[]>(); for (const p of presses) (pBy.get(p.conversation_id) ?? pBy.set(p.conversation_id, []).get(p.conversation_id)!).push(p);
  const by = new Map<string, M[]>(); for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const tab = new Map<string, Map<string, number>>();
  const counts = { multi: 0, multiWithCount: 0 };
  const fulfil = new Map<string, Map<string, number>>();
  const shows: string[] = [];
  const reTab = new Map<string, number>(); const reShows: string[] = [];
  const brainBy = new Map<string, B[]>();
  if (CHECK2) { const bl = await readAll<B>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action, decision_source, conversation_status").gte("created_at", since).order("created_at").range(f, t)); for (const b of bl) (brainBy.get(b.conversation_id) ?? brainBy.set(b.conversation_id, []).get(b.conversation_id)!).push(b); }
  for (const [cid, ms] of by) {
    const ps = pBy.get(cid) ?? [];
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || ms[i - 1].sender === "customer") continue;
      let j = i; while (j + 1 < ms.length && ms[j + 1].sender === "customer") j++;
      const turnMsgs = ms.slice(i, j + 1);
      const turn = turnMsgs.map((x) => x.text ?? "").join("\n");
      if (!turnMsgs.some((x) => BROUGHT_RE.test(x.text ?? ""))) continue;
      if (ps.some((p) => p.aix_type === "application_push" && p.created_at <= ms[j].created_at)) continue;
      const next = ms.slice(j + 1).find((x) => x.sender !== "customer");
      const nextCust = ms.slice(j + 1).find((x) => x.sender === "customer");
      if (!next) continue;
      const pressNear = ps.filter((p) => p.created_at > ms[j].created_at && Math.abs(Date.parse(p.created_at) - Date.parse(next.created_at)) < 10 * 60_000 && (!nextCust || p.created_at < nextCust.created_at));
      let staff: string;
      if (!next.is_aix_generated) {
        const c = CHECK_P_RE.test(next.text ?? ""), e = EST_P_RE.test(next.text ?? "");
        staff = c && e ? "約束=両方" : c ? "約束=確認だけ" : e ? "約束=見積だけ" : "手打ち=他";
      } else {
        const types = [...new Set(pressNear.map((p) => p.aix_type))].sort().join("+") || "AIX(不明)";
        staff = `AIX直接=${types}`;
      }
      const ask = broughtPropertyAsk(turn);
      if (CHECK2) {
        const bs = (brainBy.get(cid) ?? []).filter((b) => b.created_at >= ms[i].created_at && b.created_at <= next.created_at); const b = bs[bs.length - 1];
        if (b) {
          const src = (b.decision_source ?? "").replace(/^no_aix:/, "");
          const m2 = src.match(/two_stage_promise\((\w+)\)/);
          const fa = b.suggested_action ?? (m2 ? (m2[1] === "estimate" ? "estimate_sheet" : m2[1] === "check" || m2[1] === "check_question" ? "property_check_result" : m2[1] === "pickup" ? "property_send" : null) : null);
          const before = b.suggested_action ? `AIX:${b.suggested_action}` : m2 ? `約束(${m2[1]})` : "AIXなし";
          let after = before;
          if (fa) { const v = resolveTwoStage({ finalAix: fa, decisionSource: b.suggested_action ? (src || "llm") : "llm", pickupReady: false, postApply: isPostApplyStatus(b.conversation_status), asksCost: /初期費用|見積|いくら|費用/.test(turn), customerText: turn, brought: { ask, count: broughtPropertyCount(turnMsgs.map((x) => x.text ?? "")) } }); after = v ? `約束(${v.source.replace(/^.*\(|\)$/g, "")})` : before; }
          const k = `${staff.startsWith("約束") ? staff : staff.startsWith("AIX") ? "人=AIX直接" : "人=他"}｜前 ${before}｜後 ${after}`; reTab.set(k, (reTab.get(k) ?? 0) + 1);
          if (reShows.length < 25 && /brought_both/.test(after)) reShows.push(`${ms[j].created_at.slice(0, 10)} ${k} 客「${turn.replace(/\n/g, " ").slice(0, 50)}」人「${(next.text ?? "").replace(/\n/g, " / ").slice(0, 80)}」`);
        }
      }
      // 後で果たした形（48時間以内のこちらの送信・AIX の通と押下）: 募集状況の報告／御見積書
      {
        const lim = Date.parse(ms[j].created_at) + 48 * 3_600_000;
        const later = ms.slice(j + 1).filter((x) => x.sender !== "customer" && Date.parse(x.created_at) <= lim);
        const lp = ps.filter((p) => p.created_at > ms[j].created_at && Date.parse(p.created_at) <= lim);
        const chk = lp.some((p) => p.aix_type === "property_check_result") || later.some((x) => /募集中|募集終了|空室|申込が入|お申込み入|現在空|ご紹介可能/.test(x.text ?? ""));
        const est = lp.some((p) => p.aix_type === "estimate_sheet") || later.some((x) => /御?見積書[^\n]{0,20}(?:お送りさせて頂きました|お送りさせていただきました|となります|ご査収|同封)/.test(x.text ?? ""));
        const k = chk && est ? "後=両方" : chk ? "後=確認だけ" : est ? "後=見積だけ" : "後=なし";
        const fr = fulfil.get(ask) ?? fulfil.set(ask, new Map()).get(ask)!; fr.set(k, (fr.get(k) ?? 0) + 1);
      }
      const row = tab.get(ask) ?? tab.set(ask, new Map()).get(ask)!;
      row.set(staff, (row.get(staff) ?? 0) + 1);
      const n = broughtPropertyCount(turnMsgs.map((x) => x.text ?? ""));
      if (n >= 2 && staff.startsWith("約束")) { counts.multi++; if (/[0-9０-９二三四五]\s*(?:部屋|件|物件|軒)|それぞれ|両方|どちらも/.test(next.text ?? "")) counts.multiWithCount++; }
      if (shows.length < SHOW && staff.startsWith(process.env.SHOW_KIND ?? "約束")) shows.push(`[${ask}｜${staff}｜${n}件] 客「${turn.replace(/\n/g, " ").slice(0, 50)}」人「${(next.text ?? "").replace(/\n/g, " / ").slice(0, 90)}」`);
    }
  }
  console.log(`持ち込みの番（${DAYS}日・申込前）: お客様の言葉 × スタッフの最初の返し`);
  for (const [ask, row] of tab) {
    const n = [...row.values()].reduce((a, b) => a + b, 0);
    console.log(`  ■ ${ask}（${n}番）: ${[...row].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  console.log("後で果たした形（48時間以内）");
  for (const [ask, row] of fulfil) { const n = [...row.values()].reduce((a, b) => a + b, 0); console.log(`  ■ ${ask}（${n}番）: ${[...row].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`); }
  if (CHECK2) { console.log("ブレインの判断の当て直し（前＝その時の記録・後＝今の2段）"); for (const [k, v] of [...reTab].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`); for (const x of reShows) console.log("   " + x); }
  console.log(`  2件以上の持ち込みで約束を手打ちした ${counts.multi}番のうち、件数・それぞれ を書いた ${counts.multiWithCount}`);
  for (const s of shows) console.log("  " + s);
})().catch((e) => { console.error(e); process.exit(1); });
