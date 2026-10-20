// scripts/audit-second-message-materials.ts — AIX の2通目の外れ方を数える（読むだけ・LLM なし・決定論の確かめだけ）
// 2026-10-20 竹内さん（P1 ef272b2d）「2通目の文を作る所が弱すぎる」: 外れの型ごとに、実際の2通目で何回起きているか。
//   ① AI の下書き（aix_generate_log・source=aix-template-generate の generated_text）
//   ② スタッフが送った2通目（messages: AIX の1通目 → 間にお客様の発言なしで 15分以内に続けたスタッフの手打ち）
//   型: ご査収（何も送っていないのに）／送った物の種類の言い方／見積書 N件→名前1件／まだ答えていない質問／約束の答えが無い／費用の種類の取り違え／内覧・申込の訴求の有無
// 実行: npx tsx --env-file=.env.local scripts/audit-second-message-materials.ts [--days=30] [--show=8]
import { createClient } from "@supabase/supabase-js";
import {
  splitTurn, sentThisTurn, outstandingAsks, openPromises, askedCostKind, lastCustomerBundle,
  fixReceiptWhenNotSent, fixImageTypeWording, fixEstimateNames, unansweredAsks, costKindMismatch, hasViewingOrApplyPush,
  type SmMsg,
} from "../app/lib/second-message-materials";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30")) || 30;
const SHOW = Number(arg("show", "6")) || 0;

type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type L = { conversation_id: string; aix_type: string | null; sent_at: string | null; created_at: string };
type G = { conversation_id: string | null; action_type: string | null; generated_text: string | null; created_at: string; conditions_snapshot: { source?: string } | null };

async function pageAll<T>(q: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const KEYS = ["receipt_not_sent", "image_type", "estimate_names", "unanswered", "promise_open", "cost_kind"] as const;
type Key = typeof KEYS[number];
const JA: Record<Key, string> = {
  receipt_not_sent: "何も送っていないのにご査収",
  image_type: "送った物の種類の言い方（物件資料⇔見積書）",
  estimate_names: "見積書2件以上→名前1件以下",
  unanswered: "まだ答えていない質問（1通目・2通目のどちらも触れない）",
  promise_open: "約束の答えが無い（確認の約束が2通目の後も開いたまま・72時間内）",
  cost_kind: "費用の種類の取り違え（初期費用⇔月額）",
};

type Pop = { n: number; hit: Record<Key, number>; byKind: Record<string, { n: number; viewing: number; apply: number }>; show: Record<Key, string[]> };
const newPop = (): Pop => ({ n: 0, hit: Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<Key, number>, byKind: {}, show: Object.fromEntries(KEYS.map((k) => [k, []])) as unknown as Record<Key, string[]> });

function judge(pop: Pop, o: { recent: SmMsg[]; first: string; actionType: string | null; second: string; label: string; nowMs: number }) {
  const { before, turnStaff } = splitTurn(o.recent, o.first);
  const sent = sentThisTurn({ actionType: o.actionType, turnStaff });
  const asks = outstandingAsks(o.recent, turnStaff, o.nowMs);
  const costKind = askedCostKind(lastCustomerBundle(before));
  const s = o.second;
  const hits: Key[] = [];
  if (fixReceiptWhenNotSent(s, sent).applied.length) hits.push("receipt_not_sent");
  { const r = fixImageTypeWording(s, sent); if (r.applied.length || r.flagged.length) hits.push("image_type"); }
  { const r = fixEstimateNames(s, sent.estimates); if (r.applied.length || r.flagged.length) hits.push("estimate_names"); }
  if (unansweredAsks(asks, `${turnStaff.join("\n")}\n${s}`).length) hits.push("unanswered");
  {
    const open = openPromises(o.recent, turnStaff, o.nowMs).filter((p) => p.kind === "確認" && p.elapsedH <= 72);
    const after = openPromises(o.recent, [...turnStaff, s], o.nowMs).filter((p) => p.kind === "確認" && p.elapsedH <= 72);
    if (open.length && after.length) hits.push("promise_open");
  }
  if (costKindMismatch(s, costKind)) hits.push("cost_kind");
  pop.n++;
  for (const h of hits) {
    pop.hit[h]++;
    if (pop.show[h].length < SHOW) pop.show[h].push(`${o.label} [${sent.kind}${sent.estimates.length ? `×${sent.estimates.length}:${sent.estimates.join("|").slice(0, 80)}` : ""}] ${s.replace(/\n/g, "／").slice(0, 150)}`);
  }
  const k = sent.kind;
  const b = (pop.byKind[k] ??= { n: 0, viewing: 0, apply: 0 });
  const p = hasViewingOrApplyPush(s);
  b.n++; if (p.viewing) b.viewing++; if (p.apply) b.apply++;
}

function report(title: string, pop: Pop) {
  console.log(`\n■ ${title}: ${pop.n}通`);
  for (const k of KEYS) console.log(`  ${JA[k]}: ${pop.hit[k]}（${pop.n ? ((pop.hit[k] / pop.n) * 100).toFixed(1) : "0"}%）`);
  console.log("  内覧・申込の訴求（送った物の種類ごと）:");
  for (const [k, v] of Object.entries(pop.byKind)) console.log(`    ${k}: ${v.n}通・内覧 ${v.viewing}（${((v.viewing / v.n) * 100).toFixed(0)}%）・申込 ${v.apply}（${((v.apply / v.n) * 100).toFixed(0)}%）`);
  if (SHOW) for (const k of KEYS) for (const s of pop.show[k]) console.log(`    [${k}] ${s}`);
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const sinceCtx = new Date(Date.now() - (DAYS + 14) * 86400_000).toISOString();
  const [msgs, logs, gens] = await Promise.all([
    pageAll<M>((f) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", sinceCtx).order("conversation_id").order("created_at").order("id").range(f, f + 999)),
    pageAll<L>((f) => sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, created_at").gte("created_at", since).not("sent_at", "is", null).order("created_at").range(f, f + 999)),
    pageAll<G>((f) => sb.from("aix_generate_log").select("conversation_id, action_type, generated_text, created_at, conditions_snapshot").gte("created_at", since).order("created_at").range(f, f + 999)),
  ]);
  const byConv = new Map<string, M[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const logsByConv = new Map<string, L[]>();
  for (const l of logs) { if (!logsByConv.has(l.conversation_id)) logsByConv.set(l.conversation_id, []); logsByConv.get(l.conversation_id)!.push(l); }
  const toSm = (m: M): SmMsg => ({ sender: m.sender, text: m.text, isAix: !!m.is_aix_generated, rawCreatedAt: m.created_at });
  const actionNear = (cid: string, atIso: string): string | null => {
    const t = Date.parse(atIso);
    let best: L | null = null; let bd = Infinity;
    for (const l of logsByConv.get(cid) ?? []) { const d = Math.abs(Date.parse(l.sent_at ?? l.created_at) - t); if (d < bd && d <= 5 * 60_000) { bd = d; best = l; } }
    return best?.aix_type ?? null;
  };

  // ② スタッフが送った2通目
  const staff = newPop();
  for (const [cid, list] of byConv) {
    if (isTestConversation(cid)) continue;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      if (a.sender !== "staff" || !a.is_aix_generated || !a.text || a.created_at < since || /^\s*\[(?:画像|動画)\]\s*$/.test(a.text)) continue;
      // 1通目の後の画像（AIX の画像）は飛ばして、最初のスタッフの手打ち
      let j = i + 1;
      while (j < list.length && list[j].sender === "staff" && /^\s*\[(?:画像|動画|ファイル)\]\s*$/.test(list[j].text ?? "")) j++;
      const b = list[j];
      if (!b || b.sender !== "staff" || b.is_aix_generated || !b.text?.trim() || Date.parse(b.created_at) - Date.parse(a.created_at) > 15 * 60_000) continue;
      judge(staff, { recent: list.slice(Math.max(0, i - 30), j).map(toSm), first: a.text, actionType: actionNear(cid, a.created_at), second: b.text, label: `${b.created_at.slice(5, 16)} ${cid.slice(0, 8)}`, nowMs: Date.parse(b.created_at) });
    }
  }

  // ① AI の下書き（✨ の生成。1通目＝その時刻より前の最後の AIX）
  const ai = newPop();
  for (const g of gens) {
    if ((g.conditions_snapshot?.source ?? "") !== "aix-template-generate" || !g.conversation_id || !g.generated_text?.trim() || isTestConversation(g.conversation_id)) continue;
    const list = (byConv.get(g.conversation_id) ?? []).filter((m) => m.created_at <= g.created_at);
    let k = list.length - 1;
    while (k >= 0 && !(list[k].sender === "staff" && list[k].is_aix_generated && list[k].text && !/^\s*\[(?:画像|動画)\]\s*$/.test(list[k].text ?? ""))) { if (list[k].sender === "customer") { k = -1; break; } k--; }
    if (k < 0) continue; // 1通目が無い（2通目でない生成）
    judge(ai, { recent: list.slice(Math.max(0, k - 30)).map(toSm), first: list[k].text ?? "", actionType: g.action_type, second: g.generated_text, label: `${g.created_at.slice(5, 16)} ${g.conversation_id.slice(0, 8)}`, nowMs: Date.parse(g.created_at) });
  }

  console.log(`直近${DAYS}日（YUMA 等のテストの会話は除く）`);
  report("AI の下書き（✨ この会話に合った文を生成・aix_generate_log）", ai);
  report("スタッフが送った2通目（AIX の1通目→15分以内・お客様の発言なし）", staff);
}
main().catch((e) => { console.error(e); process.exit(1); });
