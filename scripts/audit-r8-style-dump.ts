// scripts/audit-r8-style-dump.ts — 8巡目: スタッフの返事の「書き方の形」と、それを決めていそうな条件を全期間で1番ずつ書き出す（読むだけ・LLM なし・DB は読むだけ）
//   2026-10-08 竹内「実際のLINEでパターンによって見ればよいのでは。分析したらわかるのでは。…もっと深くみることできるのか」
//   番 = お客様の連投の頭 → その後の最初のスタッフの文（AIX の文・画像だけ・スタンプを除く・次のお客様の発言まで）
//   その文の出所を分ける: hand（下書きの記録なし）／edited（AI の下書きを直して送った）／asis（下書きそのまま）／template（定型文）／aixgreet（内覧挨拶のピッカー）
//   出力: --out=<jsonl>（1行1番。条件と形）＋ --ai-out=<jsonl>（直近30日の AI の下書きの形）
// 実行: npx tsx --env-file=.env.local scripts/audit-r8-style-dump.ts --out=<path> --ai-out=<path>
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { subSceneOf, isViewingDayNotice } from "../app/lib/reply-subscene";
import { coreOf, dice, isStaffOnlyReport } from "../app/lib/text-diff-types";
import { cleanDraft } from "../app/lib/line-watch-judge";
import { styleTargets, writerOf } from "./lib/r8-style-targets";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OUT = arg("out", "");
const AI_OUT = arg("ai-out", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 1_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type M = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; line_message_id: string | null };
const jstDay = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
const jstHour = (ms: number) => new Date(ms + 9 * 3600_000).getUTCHours();
const isMedia = (t: string) => /^\[(?:画像|動画|スタンプ|ファイル|位置情報|音声)\]/.test(t.trim());
const EMO = /[\p{Extended_Pictographic}]/u;
const weekOf = (ms: number) => { const d = new Date(ms + 9 * 3600_000); const day = (d.getUTCDay() + 6) % 7; const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)); return mon.toISOString().slice(5, 10); };

async function main() {
  const msgs = await readAll<M>((f, t) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, line_message_id").order("created_at").order("id").range(f, t));
  const convs = await readAll<{ id: string; account: string | null }>((f, t) => sb.from("conversations").select("id, account").range(f, t));
  const acc = new Map(convs.map((c) => [c.id, c.account ?? "?"]));
  const aix = await readAll<{ conversation_id: string; aix_type: string; sent_at: string | null; created_at: string; generated_text: string | null; line_message_id: string | null }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, created_at, generated_text, line_message_id").range(f, t));
  const ex = await readAll<{ conversation_id: string | null; sent_reply: string | null; ai_draft: string | null; created_at: string; sent_at: string | null; template_id: string | null; customer_message: string | null }>((f, t) => sb.from("ai_reply_examples").select("conversation_id, sent_reply, ai_draft, created_at, sent_at, template_id, customer_message").eq("entry_source", "line_reply").range(f, t));
  const gv = await readAll<{ conversation_id: string; generated_text: string | null; created_at: string; action_type: string }>((f, t) => sb.from("aix_generate_log").select("conversation_id, generated_text, created_at, action_type").range(f, t));
  const tpls = await readAll<{ text: string | null; category: string | null }>((f, t) => sb.from("templates").select("text, category").range(f, t));
  console.error(`messages ${msgs.length} aix ${aix.length} ex ${ex.length} gen ${gv.length} tpl ${tpls.length}`);

  const aixLineIds = new Set(aix.map((a) => a.line_message_id).filter(Boolean) as string[]);
  const aixByConv = new Map<string, typeof aix>(); for (const a of aix) { if (!aixByConv.has(a.conversation_id)) aixByConv.set(a.conversation_id, []); aixByConv.get(a.conversation_id)!.push(a); }
  const exByConv = new Map<string, typeof ex>(); for (const e of ex) { const c = e.conversation_id ?? ""; if (!exByConv.has(c)) exByConv.set(c, []); exByConv.get(c)!.push(e); }
  const genByConv = new Map<string, typeof gv>(); for (const g of gv) { if (!genByConv.has(g.conversation_id)) genByConv.set(g.conversation_id, []); genByConv.get(g.conversation_id)!.push(g); }
  const tplCores = tpls.map((t) => ({ core: coreOf((t.text ?? "").replace(/アカウント名|〇〇|◯/g, "")), cat: t.category ?? "" })).filter((t) => t.core.length > 10);

  const by = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }

  // 1通ずつの出所
  type Src = "aix" | "aixgen" | "asis" | "edited" | "template" | "hand";
  const srcOf = (m: M): { src: Src; draft: string | null; aixType?: string } => {
    const t = (m.text ?? "").trim(); const ms = Date.parse(m.created_at);
    if (m.is_aix_generated || (m.line_message_id && aixLineIds.has(m.line_message_id))) return { src: "aix", draft: null };
    const core = coreOf(t);
    for (const a of aixByConv.get(m.conversation_id) ?? []) {
      const at = Date.parse(a.sent_at ?? a.created_at); if (Math.abs(at - ms) > 2 * 3600_000) continue;
      if (a.generated_text && dice(coreOf(a.generated_text), core) >= 0.85) return { src: "aix", draft: null, aixType: a.aix_type };
    }
    for (const g of genByConv.get(m.conversation_id) ?? []) {
      const at = Date.parse(g.created_at); if (at > ms || ms - at > 6 * 3600_000) continue;
      if (g.generated_text && dice(coreOf(g.generated_text), core) >= 0.7) return { src: "aixgen", draft: g.generated_text, aixType: g.action_type };
    }
    let best: (typeof ex)[number] | null = null; let bestD = 0;
    for (const e of exByConv.get(m.conversation_id) ?? []) {
      const at = Date.parse(e.sent_at ?? e.created_at); if (Math.abs(at - ms) > 30 * 60_000) continue;
      const d = dice(coreOf(e.sent_reply ?? ""), core); if (d > bestD) { bestD = d; best = e; }
    }
    if (best && bestD >= 0.9) {
      const dr = cleanDraft(best.ai_draft).text;
      if (dr && dr.trim() === t) return { src: "asis", draft: dr };
      if (dr) return { src: "edited", draft: dr };
    }
    for (const tp of tplCores) if (dice(tp.core, core) >= 0.85) return { src: "template", draft: null, aixType: tp.cat };
    return { src: "hand", draft: null };
  };

  const rows: Record<string, unknown>[] = [];
  for (const [cid, list] of by) {
    // 会話の段階の手掛かり（時刻つき）
    const aixL = (aixByConv.get(cid) ?? []).filter((a) => a.sent_at).map((a) => ({ at: Date.parse(a.sent_at!), type: a.aix_type }));
    for (let i = 0; i < list.length; i++) {
      if (list[i].sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
      let j = i; while (j + 1 < list.length && list[j + 1].sender === "customer") j++;
      const custMsgs = list.slice(i, j + 1);
      const custText = custMsgs.map((m) => m.text ?? "").join("\n");
      let k = j + 1; let staff: M | null = null; let aixBefore: string[] = [];
      for (; k < list.length && list[k].sender !== "customer"; k++) {
        const t = (list[k].text ?? "").trim();
        if (list[k].sender !== "staff" || !t || isMedia(t)) continue;
        const s = srcOf(list[k]);
        if (s.src === "aix") { aixBefore.push(s.aixType ?? "aix"); continue; }
        staff = list[k]; break;
      }
      if (!staff) continue;
      const src = srcOf(staff);
      const sMs = Date.parse(staff.created_at);
      const hist = list.slice(0, k);
      const staffHist = hist.filter((m) => m.sender === "staff" && (m.text ?? "").trim() && !isMedia(m.text ?? ""));
      const prevStaff = staffHist[staffHist.length - 1] ?? null;
      const prevStaffNonAix = [...staffHist].reverse().find((m) => !m.is_aix_generated) ?? null;
      const sameDayStaff = staffHist.filter((m) => jstDay(Date.parse(m.created_at)) === jstDay(sMs));
      const sameDayCust = hist.filter((m) => m.sender === "customer" && jstDay(Date.parse(m.created_at)) === jstDay(sMs));
      // 同じまとまりで後に続く文（次のお客様の発言まで）
      let after = 0, afterAix = 0, afterAixTypes: string[] = [];
      for (let q = k + 1; q < list.length && list[q].sender !== "customer"; q++) { if (list[q].sender !== "staff") continue; after++; const s2 = srcOf(list[q]); if (s2.src === "aix") { afterAix++; afterAixTypes.push(s2.aixType ?? "aix"); } }
      const aixPrior = aixL.filter((a) => a.at < sMs);
      const txtPrior = staffHist.map((m) => m.text ?? "").join("\n");
      const stage = (() => {
        if (!staffHist.some((m) => !m.is_aix_generated)) return "初回";
        if (/本日(?:は)?(?:お時間|ご内覧お越し)|ご内覧(?:頂き|いただき)ありがとう/.test(txtPrior)) return "内覧の後";
        if (aixPrior.some((a) => a.type === "meeting_place") || /待ち合わせ|現地エントランス/.test(txtPrior)) return "内覧の段取り後";
        if (aixPrior.some((a) => a.type === "estimate_sheet") || /御見積書|お見積書/.test(txtPrior)) return "見積の後";
        if (aixPrior.some((a) => /property_(?:send|recommendation)/.test(a.type)) || /ピックアップさせて(?:頂|いただ)きました|お部屋お送り(?:させて)?(?:頂|いただ)きました/.test(txtPrior)) return "物件送付後";
        return "物件の前";
      })();
      const st = staff.text!;
      const scene = resolveReplyScene({ customerText: custText }).scene;
      rows.push({
        cid, acc: acc.get(cid) ?? "?", at: staff.created_at, week: weekOf(sMs), month: new Date(sMs + 9 * 3600_000).toISOString().slice(0, 7),
        src: src.src, srcType: src.aixType ?? null, draft: src.draft,
        scene, sub: subSceneOf({ customerText: custText, prevStaffText: prevStaffNonAix?.text ?? null, scene }), stage,
        viewingDay: isViewingDayNotice(custText),
        cLen: coreOf(custText).length, cMsgs: custMsgs.length, cKeigo: /です|ます|ございます|下さい|ください/.test(custText), cEmoji: EMO.test(custText), cBang: /[！!]/.test(custText), cQ: /[？?]|ますか|でしょうか/.test(custText), cGreet: /お世話になっております|お世話になります|こんにちは|こんばんは|おはようございます/.test(custText), cNanitozo: /よろしく|宜しく/.test(custText), cThanks: /ありがとう|有難う/.test(custText),
        sLen: coreOf(st).length, sLines: st.trim().split("\n").length,
        nthToday: sameDayStaff.length + 1, custTodayBefore: sameDayCust.length, firstEver: !staffHist.some((m) => !m.is_aix_generated),
        gapPrevStaffH: prevStaff ? (sMs - Date.parse(prevStaff.created_at)) / 3600_000 : -1,
        delayH: (sMs - Date.parse(list[j].created_at)) / 3600_000, hour: jstHour(sMs), dow: new Date(sMs + 9 * 3600_000).getUTCDay(),
        aixBefore: aixBefore.length > 0, aixBeforeTypes: aixBefore, afterMsgs: after, afterAix, afterAixTypes,
        prevStaffAix: !!prevStaff?.is_aix_generated,
        nanitozoToday: sameDayStaff.some((m) => /何卒/.test(m.text ?? "")), nanitozoPrev: /何卒/.test(prevStaff?.text ?? ""), greetedToday: sameDayStaff.length > 0,
        staffOnly: isStaffOnlyReport(st), w: writerOf(st), cust: custText.slice(0, 160), staff: st,
        t: styleTargets(st), dt: src.draft ? styleTargets(src.draft) : null,
      });
    }
  }
  if (OUT) writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n"));
  console.error(`番 ${rows.length}`);

  // AI の下書き（直近30日）: ai_reply_examples の下書き＋お客様の文で小場面
  if (AI_OUT) {
    const s30 = Date.now() - 30 * 86_400_000;
    const ai: Record<string, unknown>[] = [];
    for (const e of ex) {
      if (Date.parse(e.created_at) < s30 || isTestConversation(e.conversation_id ?? "")) continue;
      const d = cleanDraft(e.ai_draft).text; if (!d || d.length < 5) continue;
      const list = by.get(e.conversation_id ?? "") ?? [];
      const at = Date.parse(e.created_at);
      const prev = [...list].reverse().find((m) => m.sender === "staff" && !m.is_aix_generated && Date.parse(m.created_at) < at - 60_000 && (m.text ?? "").trim() && !isMedia(m.text ?? ""));
      const custText = e.customer_message ?? "";
      const scene = resolveReplyScene({ customerText: custText }).scene;
      ai.push({ cid: e.conversation_id, at: e.created_at, scene, sub: subSceneOf({ customerText: custText, prevStaffText: prev?.text ?? null, scene }), t: styleTargets(d), sent: e.sent_reply ? styleTargets(e.sent_reply) : null });
    }
    writeFileSync(AI_OUT, ai.map((r) => JSON.stringify(r)).join("\n"));
    console.error(`AI の下書き ${ai.length}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
