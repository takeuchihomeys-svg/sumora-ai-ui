// scripts/audit-cost-question-estimate.ts — 費用の質問のうち、スタッフが本当に AIX【見積書送る】を押したのはどんな時か（読むだけ・LLM なし）
// 2026-10-02 竹内さんの決定「費用の質問の合図を実際の LINE から引き直す」: 180日の費用の質問 421番のうち見積書送るは 59（約14%）＝合図が広すぎる。
//   59 と残りを、会話の流れ（こちらが物件を送った後か・何時間後か・見積書は送り済みか）・言い回し・特定の物件の有無で比べる。
// 実行: npx tsx --env-file=.env.local scripts/audit-cost-question-estimate.ts [--days=180] [--show=キー=値 | --show=rule=fp|fn|tp|tn | --show=reason=理由]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { CUSTOMER_ESTIMATE_INTENT_RE, CUSTOMER_ESTIMATE_REQUEST_RE, FORM_LABEL_RE, isConditionFormMessage } from "../app/lib/line-reply-prompts";
import { costQuestionNotEstimate } from "../app/lib/cost-question-kind";
import { customerPointsAtProperty } from "../app/lib/cost-question-scope";
import { customerAsksCostComposition } from "../app/lib/cost-breakdown";
import { customerDoubtsCheapness } from "../app/lib/cost-explain-text";
import { isRentIncludedQuestion } from "../app/lib/rent-included-question";
import { resolveCostQuestionEstimate, type CostQuestionEstimateInput } from "../app/lib/cost-question-estimate";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const SHOW = arg("show", "");
// AIX の記録（aix_usage_logs）は 6月から・7月から本格的に使われている。それより前は見積書を手で送っていて「押した」が数えられない
const FROM = arg("from", "2026-07-15");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type Msg = WindowMsg & { conversation_id: string; quoted_message_id: string | null };
type Press = WindowPress & { conversation_id: string };
const OUR_PROPERTY_RE = /🌟|[0-9０-９]{2,4}号室|ご査収/;

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const early = new Date(Date.now() - (DAYS + 60) * 86_400_000).toISOString();
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, quoted_message_id").gte("created_at", early).order("created_at").order("id").range(f, t));
  const presses = await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", early).not("aix_type", "is", null).order("created_at").range(f, t));
  // ブレインの判断（その番を読んだ最後の判断）: 見積書送るは LLM が選んだか・信号（決定論）が立てたか
  const decs = await readAll<{ conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; decision_source: string | null }>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, decision_source").gte("created_at", FROM).order("created_at").range(f, t));
  const decBy = new Map<string, typeof decs>(); for (const d of decs) { if (!decBy.has(d.conversation_id)) decBy.set(d.conversation_id, []); decBy.get(d.conversation_id)!.push(d); }
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses);
  type Row = { cid: string; at: string; feat: Record<string, string>; est: boolean; outcome: string; other: string; text: string; staff: string; rule: boolean; reason: string };
  const rows: Row[] = [];
  for (const [cid, ms] of mBy) {
    if (isTestConversation(cid)) continue;
    const ps = pBy.get(cid) ?? [];
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || (i > 0 && ms[i - 1].sender === "customer") || ms[i].created_at < since || ms[i].created_at < FROM) continue;
      const turnMsgs: Msg[] = [];
      for (let j = i; j < ms.length && ms[j].sender === "customer"; j++) turnMsgs.push(ms[j]);
      const t = turnMsgs.map((m) => m.text ?? "").join("\n");
      if (isConditionFormMessage(t) || !CUSTOMER_ESTIMATE_INTENT_RE.test(t.replace(FORM_LABEL_RE, " "))) continue;
      const w = staffWindowOf({ customerTurnAt: ms[i].created_at, msgs: ms, presses: ps });
      if (!w.closed || !w.staffFirstAt) continue;
      const at = ms[i].created_at;
      const before = ms.slice(0, i);
      const psBefore = ps.filter((p) => p.created_at < at);
      const sendTimes = [
        ...psBefore.filter((p) => p.aix_type === "property_send" || p.aix_type === "property_recommendation" || p.aix_type === "property_check_result").map((p) => p.created_at),
        ...before.filter((m) => m.sender !== "customer" && OUR_PROPERTY_RE.test(m.text ?? "")).map((m) => m.created_at),
      ].sort();
      const lastSend = sendTimes[sendTimes.length - 1] ?? null;
      const estTimes = psBefore.filter((p) => p.aix_type === "estimate_sheet").map((p) => p.created_at).sort();
      const lastEst = estTimes[estTimes.length - 1] ?? null;
      const input: CostQuestionEstimateInput = {
        turnText: t,
        turnHasImage: turnMsgs.some((m) => /^\[画像\]/.test(m.text ?? "")),
        turnQuotesOurMessage: turnMsgs.some((m) => !!m.quoted_message_id),
        hoursSinceOurLastPropertySend: lastSend ? (Date.parse(at) - Date.parse(lastSend)) / 3_600_000 : null,
        estimateSentSinceLastPropertySend: !!(lastEst && (!lastSend || lastEst >= lastSend)),
        customerSentPropertyEarlier: before.filter((m) => m.sender === "customer").slice(-6).some((m) => /https?:\/\/|^\[画像\]/.test(m.text ?? "")),
      };
      const r = resolveCostQuestionEstimate(input);
      const hrs = input.hoursSinceOurLastPropertySend;
      const feat: Record<string, string> = {
        "見積の語": /見積/.test(t) ? "あり" : "なし",
        "見積の依頼形": CUSTOMER_ESTIMATE_REQUEST_RE.test(t) ? "あり" : "なし",
        "この発言で物件を指す": customerPointsAtProperty(t) ? "あり" : "なし",
        "画像つき": input.turnHasImage ? "あり" : "なし",
        "引用返信": input.turnQuotesOurMessage ? "あり" : "なし",
        "こちらの物件送付": hrs === null ? "送付なし" : hrs <= 3 ? "3時間以内" : hrs <= 24 ? "3〜24時間" : hrs <= 72 ? "1〜3日" : "3日超",
        "送付後に見積書済み": input.estimateSentSinceLastPropertySend ? "済み" : "まだ",
        "直前にお客様が物件(URL/画像)": input.customerSentPropertyEarlier ? "あり" : "なし",
        "種類": costQuestionNotEstimate(t) ?? (isRentIncludedQuestion(t) ? "家賃込みか" : customerDoubtsCheapness(t) ? "安さへの不審" : customerAsksCostComposition(t) ? "中身(S9)" : "その他"),
        "ブレイン": ((): string => {
          const turnEnd = turnMsgs[turnMsgs.length - 1].created_at;
          const d = (decBy.get(cid) ?? []).filter((x) => x.analyzed_msg_ts && x.analyzed_msg_ts >= at && x.analyzed_msg_ts <= turnEnd).pop();
          if (!d) return "記録なし";
          const src = (d.decision_source ?? "").startsWith("signal:") ? "信号" : (d.decision_source ?? "").startsWith("llm") ? "LLM" : (d.decision_source ?? "other").split(":")[0];
          return `${d.suggested_action ?? "null"}(${src})`;
        })(),
      };
      const bp = w.presses.filter((p) => p.burst).map((p) => p.aix_type);
      const allP = w.presses.map((p) => p.aix_type);
      const burstText = w.texts.filter((x) => x.burst).map((x) => x.text).join("\n");
      // スタッフがその番でしたこと（見積書の AIX／見積書を手で約束・送付／物件確認した（御見積書同封を含む）／他）
      const outcome = bp.includes("estimate_sheet") ? "見積書送る(すぐ)"
        : allP.includes("estimate_sheet") ? "見積書送る(後で)"
        : /見積書?[^\n]{0,12}(?:お送り|作成|送ら|お出し|出させ)|初期費用[:：]\s*[0-9]/.test(burstText) ? "見積書を手で約束・送付"
        : bp.includes("property_check_result") ? "物件確認した"
        : bp.length ? "他のAIX" : "手打ち(見積なし)";
      rows.push({ cid, at, feat, outcome, est: bp.includes("estimate_sheet"), other: bp.filter((a) => a !== "estimate_sheet").join("+"), text: t.replace(/\n/g, " ").slice(0, 110), staff: w.texts.filter((x) => x.burst).map((x) => x.text).join(" / ").replace(/\n/g, " ").slice(0, 90), rule: r.estimate, reason: r.reason });
    }
  }
  const est = rows.filter((r) => r.est).length;
  console.log(`費用の質問 ${rows.length}番（${FROM}〜）・見積書送る ${est}（${((est / rows.length) * 100).toFixed(1)}%）`);
  const oc = new Map<string, number>(); for (const r of rows) oc.set(r.outcome, (oc.get(r.outcome) ?? 0) + 1);
  console.log("  スタッフがしたこと:", [...oc].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・"));
  for (const k of Object.keys(rows[0]?.feat ?? {})) {
    const m = new Map<string, { n: number; e: number }>();
    for (const r of rows) { const v = r.feat[k]; const c = m.get(v) ?? { n: 0, e: 0 }; c.n++; if (r.est) c.e++; m.set(v, c); }
    console.log(`\n■ ${k}`);
    for (const [v, c] of [...m].sort((a, b) => b[1].n - a[1].n)) {
      const sub = rows.filter((r) => r.feat[k] === v);
      const em = sub.filter((r) => r.outcome.startsWith("見積書")).length;
      console.log(`  ${v.padEnd(12)} n=${String(c.n).padStart(3)} 見積書送る(すぐ)=${String(c.e).padStart(3)} (${((c.e / c.n) * 100).toFixed(0)}%)・見積書の動き全体=${em} (${((em / c.n) * 100).toFixed(0)}%)`);
    }
  }
  const tp = rows.filter((r) => r.rule && r.est).length, fp = rows.filter((r) => r.rule && !r.est).length, fn = rows.filter((r) => !r.rule && r.est).length;
  console.log(`\n■ 規則 resolveCostQuestionEstimate: 見積書送るとした ${tp + fp}（うちスタッフも押した ${tp}・押さなかった ${fp}）／規則は外したがスタッフは押した ${fn}`);
  console.log(`  適合率 ${((tp / Math.max(1, tp + fp)) * 100).toFixed(0)}%・再現率 ${((tp / Math.max(1, est)) * 100).toFixed(0)}%（旧の合図＝全部見積書送る: 適合率 ${((est / rows.length) * 100).toFixed(0)}%）`);
  const byReason = new Map<string, { n: number; e: number }>();
  for (const r of rows) { const c = byReason.get(r.reason) ?? { n: 0, e: 0 }; c.n++; if (r.est) c.e++; byReason.set(r.reason, c); }
  for (const [v, c] of [...byReason].sort((a, b) => b[1].n - a[1].n)) {
    const oc2 = new Map<string, number>(); for (const r of rows.filter((x) => x.reason === v)) oc2.set(r.outcome, (oc2.get(r.outcome) ?? 0) + 1);
    console.log(`  理由 ${v.padEnd(28)} n=${String(c.n).padStart(3)} 見積書送る=${c.e}｜${[...oc2].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・")}`);
  }
  const em = (r: Row) => r.outcome.startsWith("見積書");
  const tp2 = rows.filter((r) => r.rule && em(r)).length, all2 = rows.filter(em).length;
  console.log(`  見積書の動き全体（すぐ・後で・手で）を正解にすると: 適合率 ${((tp2 / Math.max(1, tp + fp)) * 100).toFixed(0)}%（旧 ${((all2 / rows.length) * 100).toFixed(0)}%）・再現率 ${((tp2 / Math.max(1, all2)) * 100).toFixed(0)}%`);
  const chk = rows.filter((r) => r.reason.startsWith("持ち込み"));
  console.log(`  持ち込み→物件確認した の番 ${chk.length}: 物件確認した or 確認の宣言の手打ち ${chk.filter((r) => r.outcome === "物件確認した" || (r.outcome === "手打ち(見積なし)" && /募集状況|確認させて/.test(r.staff))).length}・見積書の動き ${chk.filter(em).length}`);
  if (SHOW) {
    const [k, v] = SHOW.split("=");
    const pick = rows.filter((r) => k === "rule" ? (v === "fp" ? r.rule && !r.est : v === "fn" ? !r.rule && r.est : v === "tp" ? r.rule && r.est : !r.rule && !r.est) : k === "reason" ? r.reason === v : k === "outcome" ? r.outcome === v : r.feat[k] === v);
    for (const r of pick) console.log(`  ${r.outcome}｜${r.cid.slice(0, 8)} ${r.at.slice(0, 10)}｜${r.reason}｜C:${r.text}｜S:${r.staff}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
