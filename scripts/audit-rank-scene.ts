// 番手の場面（ブレインの「並行で探す」の場面・申込までの地図の分かれ道）を、旧の語（RANK_WAITING_RE）と新の読み分け（parallel-second.latestRankMention）で比べる
// 読み取りのみ・LLM なし・DB に書かない。出力は件数と会話ID先頭8桁・伏せた文だけ。
// 2026-10-21: 旧は「2〜9番手／繰り上が」の語だけで「番手待ち」にしていた（案内「2番手でのお申込可能」「よろしければ2番手で…」にも当たる）。
//   新: 申込んだ・待っている → rank_waiting／案内（まだ申込んでいない）→ rank_offered／受け付けていない・保証会社の2番手・終わった → 番手の場面にしない。
//   全ターン（お客様の発言の後にこちらが応えた番）を、その時点の状況（customer-state）で当てる。
// 実行: npx tsx --env-file=.env.local scripts/audit-rank-scene.ts [--days=365] [--exam]（--exam は試験の問題の時点も見る）
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveParallelSearchScene, parallelSearchInputsFromMessages, hasParallelTrigger, STOP_SEARCH_RE, RANK_WAITING_RE, type ParallelSearchContext } from "../app/lib/parallel-search";
import { latestRankMention } from "../app/lib/parallel-second";
import { resolveCustomerState, type CustomerStateInput, type CustomerState } from "../app/lib/customer-state";
import { maskPII } from "../app/lib/pii-mask";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 365);
const DAY = 86_400_000;
const id8 = (s: string) => s.slice(0, 8);
const N = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");

/** 旧の場面（rank の所だけ旧の語・ほかは今と同じ） */
function oldScene(st: CustomerState | null, inp: { customerTurnText: string; recentStaffTexts: string[]; silenceDays: number | null }, nowMs: number): string | null {
  if (!st || st.stage === "won" || st.stage === "dropped" || st.stage === "first" || st.stage === "searching") return null;
  if (STOP_SEARCH_RE.test(N(inp.customerTurnText))) return null;
  if (inp.recentStaffTexts.some((t) => RANK_WAITING_RE.test(N(t)) && !/1番手/.test(t ?? ""))) return "rank_waiting";
  const r: ParallelSearchContext = resolveParallelSearchScene({ state: st, ...inp, recentStaffTexts: [], nowMs });
  return r.scene;
}
/** 地図の番手の分かれ道（ほかの分かれ道の前後は見ない・番手の所だけ） */
function oldBranch(post: boolean, staff: string[]): string | null {
  return !post && staff.some((t) => RANK_WAITING_RE.test(N(t)) && !/1番手/.test(N(t))) ? "rank_waiting" : null;
}
function newBranch(post: boolean, staff: string[]): string | null {
  const r = post ? null : latestRankMention(staff);
  return r === "applied" ? "rank_waiting" : r === "offered" ? "rank_offered" : null;
}

async function all(table: string, cols: string, ids: string[]): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    for (let a = 0; ; a += 1000) {
      const { data, error } = await sb.from(table).select(cols).in("conversation_id", ids.slice(i, i + 50)).range(a, a + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const cand = new Set<string>();
  for (let a = 0; ; a += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").gte("created_at", since).neq("sender", "customer").or("text.ilike.%番手%,text.ilike.%繰り上%").order("id").range(a, a + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) cand.add(r.conversation_id as string);
    if (!data || data.length < 1000) break;
  }
  const examAt: Array<{ id: string; conv: string; at: string; mentions: boolean }> = [];
  if (process.argv.includes("--exam")) {
    const spec = JSON.parse(readFileSync(join(process.cwd(), "scripts/brain-exam/spec.json"), "utf8")) as Array<{ id?: string; conv?: string; at?: string }>;
    for (const p of spec) if (p.conv && p.at && p.id) { examAt.push({ id: p.id, conv: p.conv, at: p.at, mentions: /番手|繰り上/.test(JSON.stringify(p)) }); cand.add(p.conv); }
  }
  const ids = [...cand].filter((id) => !isTestConversation(id));
  const { data: convs } = await sb.from("conversations").select("id, status, customer_name, line_source_type").in("id", ids);
  const convOf = new Map((convs ?? []).map((c: any) => [c.id, c]));
  const msgs = await all("messages", "conversation_id, sender, text, created_at, is_aix_generated", ids);
  const aix = (await all("aix_usage_logs", "conversation_id, aix_type, created_at, sent_at, property_names, prop_statuses, estimate_sent, generated_text, check_pattern", ids)).filter((a) => a.sent_at);
  const sf = await all("sent_facts", "conversation_id, sent_at, origin, aix_type, kind, status, detail", ids);
  const vh = await all("viewing_history", "*", ids);
  const sp = await all("sent_properties", "conversation_id, property_customer_id, property_name, room_no, sent_at, source, channel", ids);
  const sh = await all("conversation_stage_history", "conversation_id, from_status, to_status, changed_at, trigger", ids);
  const g = <T,>(arr: T[], k: (x: T) => string) => { const m = new Map<string, T[]>(); for (const x of arr) { const kk = k(x); if (!m.has(kk)) m.set(kk, []); m.get(kk)!.push(x); } return m; };
  const mBy = g(msgs, (x: any) => x.conversation_id), aBy = g(aix, (x: any) => x.conversation_id), fBy = g(sf, (x: any) => x.conversation_id), vBy = g(vh, (x: any) => x.conversation_id), pBy = g(sp, (x: any) => x.conversation_id), hBy = g(sh, (x: any) => x.conversation_id);
  for (const v of mBy.values()) v.sort((a: any, b: any) => a.created_at.localeCompare(b.created_at));

  const stateAt = (cid: string, at: number): CustomerState | null => {
    const c = convOf.get(cid);
    const cut = (iso: string | null | undefined) => iso != null && Date.parse(iso) <= at;
    const hist = (hBy.get(cid) ?? []).slice().sort((a: any, b: any) => a.changed_at.localeCompare(b.changed_at));
    let status: string | null = null;
    if (hist.length) { const before = hist.filter((h: any) => Date.parse(h.changed_at) <= at); status = before.length ? before[before.length - 1].to_status : hist[0].from_status ?? c?.status ?? null; }
    const input: CustomerStateInput = {
      now: at, status, isPostApply: ["applying", "application", "screening"].includes(status ?? ""), statusManualBackAt: null,
      messages: (mBy.get(cid) ?? []).filter((m: any) => cut(m.created_at)).map((m: any) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated })),
      aixRows: (aBy.get(cid) ?? []).filter((a: any) => cut(a.sent_at)).map((a: any) => ({ ...a })),
      recordedFacts: (fBy.get(cid) ?? []).filter((f: any) => cut(f.sent_at)).sort((a: any, b: any) => a.sent_at.localeCompare(b.sent_at)),
      viewingHistory: (vBy.get(cid) ?? []).filter((v: any) => cut(v.created_at)),
      sentProperties: (pBy.get(cid) ?? []).filter((x: any) => cut(x.sent_at)),
    } as CustomerStateInput;
    try { return resolveCustomerState(input); } catch { return null; }
  };

  const sceneTab: Record<string, number> = {}, branchTab: Record<string, number> = {};
  const oldCount: Record<string, number> = {}, newCount: Record<string, number> = {};
  const ex: Record<string, string[]> = {};
  let turns = 0;
  const judge = (cid: string, t: number, ms: any[]) => {
    const newestFirst = ms.filter((m: any) => Date.parse(m.created_at) <= t).slice(-15).reverse().map((x: any) => ({ sender: x.sender, text: x.text, created_at: x.created_at }));
    const inp = parallelSearchInputsFromMessages(newestFirst);
    const st = stateAt(cid, t);
    const o = oldScene(st, inp, t);
    const n = resolveParallelSearchScene({ state: st, ...inp, nowMs: t }).scene;
    const post = st?.stage === "applying" || st?.stage === "won";
    return { o, n, ob: oldBranch(post, inp.recentStaffTexts), nb: newBranch(post, inp.recentStaffTexts), inp, st };
  };
  for (const cid of ids) {
    const c = convOf.get(cid);
    if (!c || c.line_source_type === "group") continue;
    const ms = mBy.get(cid) ?? [];
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]; if (m.sender !== "customer") continue;
      const nx = ms[i + 1]; if (nx && nx.sender === "customer") continue;
      if (m.created_at < since) continue;
      const t = Date.parse(m.created_at);
      const { o, n, ob, nb, inp } = judge(cid, t, ms);
      turns++;
      oldCount[o ?? "なし"] = (oldCount[o ?? "なし"] ?? 0) + 1; newCount[n ?? "なし"] = (newCount[n ?? "なし"] ?? 0) + 1;
      const k = `${o ?? "なし"} → ${n ?? "なし"}`; sceneTab[k] = (sceneTab[k] ?? 0) + 1;
      const kb = `${ob ?? "なし"} → ${nb ?? "なし"}`; if (ob || nb) branchTab[kb] = (branchTab[kb] ?? 0) + 1;
      if (o !== n) {
        const s = inp.recentStaffTexts.map((x) => N(x).split(/[\n。]/).filter((y) => /番手|繰り上/.test(y)).join(" / ")).find(Boolean) ?? "";
        (ex[k] ??= []).push(`${id8(cid)} ${m.created_at.slice(0, 10)} こちら「${maskPII(s, [c.customer_name]).slice(0, 70)}」 お客様「${maskPII(N(inp.customerTurnText).replace(/\s+/g, " "), [c.customer_name]).slice(0, 30)}」${hasParallelTrigger(inp.customerTurnText) ? "（きっかけあり）" : ""}`);
      }
    }
  }
  console.log(`候補 ${ids.length} 会話（${days}日にこちらの番手・繰り上の文がある）・お客様の番 ${turns}`);
  console.log(`旧の場面: ${JSON.stringify(oldCount)}`);
  console.log(`新の場面: ${JSON.stringify(newCount)}`);
  console.log(`食い違い（旧 → 新）:`);
  for (const [k, v] of Object.entries(sceneTab).filter(([k]) => k.split(" → ")[0] !== k.split(" → ")[1]).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
    for (const x of (ex[k] ?? []).slice(0, 8)) console.log(`    ${x}`);
  }
  console.log(`地図の番手の分かれ道（申込前・番手の所だけ・ほかの分かれ道が先に開く番も含む）: ${JSON.stringify(branchTab)}`);

  if (examAt.length) {
    console.log(`\n試験の問題の時点（番手の語がある問題・場面と地図の番手）:`);
    for (const q of examAt) {
      const ms = mBy.get(q.conv) ?? [];
      const t = Date.parse(q.at);
      const { o, n, ob, nb, inp } = judge(q.conv, t, ms);
      const rankText = inp.recentStaffTexts.some((x) => /番手|繰り上/.test(N(x)));
      if (!rankText && !q.mentions && o === n && ob === nb) continue;
      console.log(`  ${q.id} ${id8(q.conv)} 場面 ${o ?? "なし"} → ${n ?? "なし"}・地図 ${ob ?? "なし"} → ${nb ?? "なし"}${o === n && ob === nb ? "（同じ）" : "（変わる）"}${q.mentions ? "・問題に番手の語" : ""}${rankText ? "・直前のこちらに番手の文" : ""}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
