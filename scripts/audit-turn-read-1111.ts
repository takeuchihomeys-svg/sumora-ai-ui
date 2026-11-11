// scripts/audit-turn-read-1111.ts — お客様の一通を「対象 × 意図 × 気持ち」まで読めているかを、竹内さん本人の番で測る（作業員14・2026-11-11）
//
// 竹内さん 11/11（KB 5cb0dd4c）「物件をさすか・内覧にいきたいのか・この部屋を気に入っているのか（どれか言っていない場合文脈から見つける）…
//   お客さんの潜在意識の部分や気持ちの部分。ここを細かく何のことか理解できればより質上がる」
//   追加「実際の竹内の返信より、何のことなのか細かい対象と要点も」
// 正解は竹内さん本人の実際の返信から逆に読む: ①細かい対象 ②竹内さんの返信が答えた要点（順番・省いた事）③お客様の意図と気持ち。
// それを本番のブレインの記録（brain_decision_logs.digest の prop・ms・intent・cs・q・la）と下書き（line_watch_turns.draft_first）と比べる。
//
// 段:
//   --phase=build   竹内さんの番を選ぶ（LLM なし・会話を絞って読む・本番 DB は読むだけ）→ scripts/.replay-out/turnread-turns.json
//   --phase=gold    DeepSeek で正解を3回付ける（伏せた文だけ・申込の書類の手前で切る）→ turnread-gold.json
//   --phase=judge   DeepSeek でブレインの読み・下書きと正解を比べる（1回）→ turnread-judge.json
//   --phase=report  数える
// 実行:
//   npx tsx --env-file=.env.local scripts/audit-turn-read-1111.ts --phase=build --n=100 [--since=2026-10-12]
//   LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/audit-turn-read-1111.ts --phase=gold --limit=30 --max-usd=0.15
// 毎朝の数え（TURN_READ=log の本番の記録・前の日の竹内さんの番・11/12〜1週間）: 安い時間（〜10時）に
//   D=前の日; T=今日（JST の日付の 00:00 を UTC で: 例 2026-11-11T15:00Z〜2026-11-12T15:00Z）
//   npx tsx --env-file=.env.local scripts/audit-turn-read-1111.ts --phase=build --since=<D> --until=<T> --n=60 --tag=daily-<日付>
//   LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/audit-turn-read-1111.ts --phase=gold --tag=daily-<日付> --max-usd=0.1
//   LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/audit-turn-read-1111.ts --phase=judge --tag=daily-<日付> --max-usd=0.05
//   npx tsx --env-file=.env.local scripts/audit-turn-read-1111.ts --phase=report --tag=daily-<日付>   … ①対象（digest.ta の about）・③意図（判定）
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { isTestConversation } from "../app/lib/test-conversations";
import { applicationMaterialReason, piiValueSignal } from "../app/lib/test-pii-guard";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";
import { MINDSET_STATES } from "../app/lib/customer-mindset";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const PHASE = arg("phase", "build");
const OUT = path.join(__dirname, ".replay-out");
const TAG = arg("tag", ""); const sfx = TAG ? `-${TAG}` : "";
const TURNS_FILE = path.join(OUT, `turnread-turns${sfx}.json`);
const GOLD_FILE = path.join(OUT, `turnread-gold${sfx}.json`);
const JUDGE_FILE = path.join(OUT, `turnread-judge${sfx}.json`);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost", (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "x"));

type M = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };
export type Turn = {
  id: string; cid: string; at: string; scene: string | null;
  context: string[];          // 直前の通（伏せた・古い順・最大8）
  customer: string;           // お客様の今の連投（伏せた）
  takeuchi: string[];         // 竹内さんの返信（手で書いた通・伏せた）
  aix: string[];              // その番に送った AIX（種類・ピッカー）
  draft: string | null;       // AI の最初の下書き（伏せた）
  blocks: Record<string, number> | null; // ブレインに届いた材料の欄と字数（line_watch_turns.materials.brain.blocks.chars）
  brain: { action: string | null; prop: string | null; ms: string | null; intent: string | null; cs: string | null; q: string[]; la: string | null; concern: string | null; cp: string | null; ta?: string[] | null; li?: string | null } | null;
};

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 200_000; i += 1000) { const { data, error } = await q(i); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  return out;
}
// 決まった並べ替え（毎回同じ番を選ぶ）
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

async function build() {
  const N = Number(arg("n", "100"));
  const since = arg("since", "2026-10-12"); const until = arg("until", "2099-01-01");   // 毎朝の数え: --since=前の日 --until=今日 --tag=daily-YYYYMMDD   // digest.ms（気持ち）が全部の番に付いた週から
  type LW = { conversation_id: string; customer_turn_at: string; customer_last_at: string | null; draft_first: string | null; scene_key: string | null; conv_status: string | null; decision_id: string | null; materials: { brain?: { blocks?: { chars?: Record<string, number> } } } | null };
  const lw = await all<LW>((i) => sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, draft_first, scene_key, conv_status, decision_id, materials").gte("customer_turn_at", since).lt("customer_turn_at", until).not("decision_id", "is", null).order("customer_turn_at").range(i, i + 999));
  const cand = lw.filter((t) => !isTestConversation(t.conversation_id) && !(t.scene_key ?? "").startsWith("対象外"));
  // 会話ごとに最大3番・決まった順で 4倍まで候補に
  const byConv = new Map<string, LW[]>(); for (const t of cand) (byConv.get(t.conversation_id) ?? byConv.set(t.conversation_id, []).get(t.conversation_id)!).push(t);
  const picked: LW[] = [];
  for (const [cid, ts] of [...byConv].sort((a, b) => hash(a[0]) - hash(b[0]))) { void cid; picked.push(...[...ts].sort((a, b) => hash(a.customer_turn_at) - hash(b.customer_turn_at)).slice(0, 3)); if (picked.length >= N * 4) break; }
  const cids = [...new Set(picked.map((t) => t.conversation_id))];
  console.log(`line_watch_turns ${lw.length}・候補 ${cand.length}・選んだ候補 ${picked.length}（会話 ${cids.length}）`);
  const convs: Array<{ id: string; line_source_type: string | null; customer_name: string | null }> = [];
  const outs: Array<{ conversation_id: string; applied_at: string | null }> = [];
  const aix: Array<{ conversation_id: string; aix_type: string | null; check_pattern: string | null; sent_at: string | null }> = [];
  const msgs: M[] = [];
  const pre = new Date(Date.parse(since) - 20 * 86_400_000).toISOString();
  for (let i = 0; i < cids.length; i += 20) {
    const ids = cids.slice(i, i + 20);
    const [c, o, a] = await Promise.all([
      sb.from("conversations").select("id, line_source_type, customer_name").in("id", ids),
      sb.from("deal_outcomes").select("conversation_id, applied_at").in("conversation_id", ids).not("applied_at", "is", null),
      sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at").in("conversation_id", ids).not("sent_at", "is", null).gte("sent_at", since),
    ]);
    convs.push(...(c.data ?? [])); outs.push(...(o.data ?? [])); aix.push(...(a.data ?? []));
    msgs.push(...await all<M>((f) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer").in("conversation_id", ids).gte("created_at", pre).order("created_at").order("id").range(f, f + 999)));
    process.stdout.write(`\r  会話 ${Math.min(i + 20, cids.length)}/${cids.length}・通 ${msgs.length}`);
  }
  console.log("");
  const convBy = new Map(convs.map((c) => [c.id, c]));
  const appliedAt = new Map<string, number>(); for (const o of outs) { const t = Date.parse(o.applied_at!); const p = appliedAt.get(o.conversation_id); if (p == null || t < p) appliedAt.set(o.conversation_id, t); }
  const msgBy = new Map<string, M[]>(); for (const m of msgs) (msgBy.get(m.conversation_id) ?? msgBy.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  const decIds = picked.map((t) => t.decision_id!).filter(Boolean);
  const decs: Array<{ id: string; suggested_action: string | null; digest: Record<string, unknown> | null }> = [];
  for (let i = 0; i < decIds.length; i += 100) { const { data } = await sb.from("brain_decision_logs").select("id, suggested_action, digest").in("id", decIds.slice(i, i + 100)); decs.push(...(data ?? [])); }
  const decBy = new Map(decs.map((d) => [d.id, d]));

  const turns: Turn[] = []; const skip: Record<string, number> = {};
  const sk = (k: string) => { skip[k] = (skip[k] ?? 0) + 1; };
  for (const t of picked) {
    if (turns.length >= N) break;
    const conv = convBy.get(t.conversation_id);
    if (conv?.line_source_type === "group") { sk("グループ"); continue; }
    const list0 = msgBy.get(t.conversation_id) ?? [];
    // 申込の書類・個人の値・申込の日の手前で切る
    const ap = appliedAt.get(t.conversation_id) ?? Infinity;
    let cut = list0.length;
    for (let i = 0; i < list0.length; i++) { const m = list0[i]; if (Date.parse(m.created_at) >= ap || (m.sender === "customer" && (applicationMaterialReason(m.text) || piiValueSignal(m.text)))) { cut = i; break; } }
    const list = list0.slice(0, cut);
    const bStart = Date.parse(t.customer_turn_at), bEnd = Date.parse(t.customer_last_at ?? t.customer_turn_at);
    const iStart = list.findIndex((m) => m.sender === "customer" && Math.abs(Date.parse(m.created_at) - bStart) < 2000);
    if (iStart < 0) { sk("番の通が無い・切った後"); continue; }
    let j = iStart; while (j + 1 < list.length && list[j + 1].sender === "customer" && Date.parse(list[j + 1].created_at) <= bEnd + 2000) j++;
    const k = j + 1;
    if (k >= list.length || list[k].sender === "customer") { sk("こちらの返事が無い"); continue; }
    const first = list[k];
    if (first.staff_writer !== "takeuchi") { sk("竹内さん以外"); continue; }
    if (Date.parse(first.created_at) - bEnd > 48 * 3600_000) { sk("48時間後"); continue; }
    let e = k; while (e + 1 < list.length && list[e + 1].sender !== "customer") e++;
    const resp = list.slice(k, e + 1);
    const names = addressNamesOf(list.filter((m) => m.sender !== "customer").map((m) => m.text ?? ""));
    const mask = (s: string | null) => maskExamText(s, conv?.customer_name ?? null, names);
    const customer = list.slice(iStart, j + 1).map((m) => mask(m.text)).filter(Boolean).join("\n").slice(0, 700);
    if (!customer.trim()) { sk("空"); continue; }
    const context = list.slice(Math.max(0, iStart - 8), iStart).map((m) => `${m.sender === "customer" ? "【お客様】" : m.is_aix_generated ? "【こちら・AIX】" : "【こちら】"}${mask(m.text).replace(/\s+/g, " ").slice(0, 260)}`);
    const takeuchi = resp.filter((m) => !m.is_aix_generated && (m.text ?? "").trim()).map((m) => mask(m.text).slice(0, 700));
    const respEnd = Date.parse(resp[resp.length - 1].created_at) + 60_000;
    const ax = aix.filter((a) => a.conversation_id === t.conversation_id && Date.parse(a.sent_at!) >= bEnd - 60_000 && Date.parse(a.sent_at!) <= respEnd).map((a) => `${a.aix_type ?? "?"}${a.check_pattern ? `（${a.check_pattern}）` : ""}`);
    const aixTexts = resp.filter((m) => m.is_aix_generated).map((m) => `AIX文: ${mask(m.text).replace(/\s+/g, " ").slice(0, 200)}`);
    if (!takeuchi.length && !ax.length && !aixTexts.length) { sk("中身なし"); continue; }
    const d = decBy.get(t.decision_id!);
    const g = (d?.digest ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? mask(v) : null);
    turns.push({
      id: `${t.conversation_id.slice(0, 8)}-${t.customer_turn_at.slice(0, 16)}`, cid: t.conversation_id, at: t.customer_turn_at, scene: t.scene_key,
      context, customer, takeuchi, aix: [...ax, ...aixTexts], draft: t.draft_first ? mask(t.draft_first).slice(0, 700) : null, blocks: t.materials?.brain?.blocks?.chars ?? null,
      brain: d ? { action: d.suggested_action, prop: str(g.prop), ms: str(g.ms), intent: str(g.intent), cs: str(g.cs), q: Array.isArray(g.q) ? (g.q as unknown[]).map((x) => mask(String(x))) : [], la: str(g.la), concern: str(g.concern), cp: str(g.cp), ta: Array.isArray(g.ta) ? (g.ta as unknown[]).map((x) => mask(String(x))) : null, li: str(g.li) } : null,
    });
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(TURNS_FILE, JSON.stringify(turns, null, 1));
  console.log(`竹内さんの番 ${turns.length}（会話 ${new Set(turns.map((x) => x.cid)).size}）→ ${TURNS_FILE}`);
  console.log(`  外した: ${JSON.stringify(skip)}`);
  console.log(`  AIX あり ${turns.filter((x) => x.aix.length).length}・手の返信あり ${turns.filter((x) => x.takeuchi.length).length}・下書きあり ${turns.filter((x) => x.draft).length}・ブレインの記録あり ${turns.filter((x) => x.brain).length}`);
}

// ── 気持ちの細分化の材料（11/11 竹内さん KB 542e92c9「気持ちも実際のやり取りから細かく細分化しておく」）──────────
// 入力: --cands=<json>（[{conversation_id, created_at＝お客様の束の最後の通}]・SQL で竹内さんの番を選んだ物）。会話ごとに最大 --per=2・--n 番まで。
// ブレインの記録は古い番には無いので持たない。その後の進み（14日以内の内覧・30日以内の申込・7日以内の返事）だけ持つ（申込の中身は使わない）。
export type MoodTurn = Turn & { after: { viewing14: boolean; applied30: boolean; replied7: boolean } };
async function buildMood() {
  const N = Number(arg("n", "300")); const PER = Number(arg("per", "2"));
  const cands: Array<{ conversation_id: string; created_at: string }> = JSON.parse(fs.readFileSync(arg("cands", path.join(OUT, "mood-cands.json")), "utf8"));
  const per = new Map<string, number>(); const picked: typeof cands = [];
  for (const c of cands) { if (isTestConversation(c.conversation_id)) continue; const k = per.get(c.conversation_id) ?? 0; if (k >= PER) continue; per.set(c.conversation_id, k + 1); picked.push(c); }
  const cids = [...new Set(picked.map((c) => c.conversation_id))];
  const convs: Array<{ id: string; line_source_type: string | null; customer_name: string | null }> = [];
  const outs: Array<{ conversation_id: string; applied_at: string | null; viewing_at: string | null }> = [];
  const aix: Array<{ conversation_id: string; aix_type: string | null; check_pattern: string | null; sent_at: string | null }> = [];
  const views: Array<{ conversation_id: string; created_at: string }> = [];
  const msgs: M[] = [];
  for (let i = 0; i < cids.length; i += 15) {
    const ids = cids.slice(i, i + 15);
    const [c, o, a, v, vh] = await Promise.all([
      sb.from("conversations").select("id, line_source_type, customer_name").in("id", ids),
      sb.from("deal_outcomes").select("conversation_id, applied_at, viewing_at").in("conversation_id", ids),
      sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at").in("conversation_id", ids).not("sent_at", "is", null),
      sb.from("viewings").select("conversation_id, created_at").in("conversation_id", ids),
      sb.from("viewing_history").select("conversation_id, created_at").in("conversation_id", ids),
    ]);
    convs.push(...(c.data ?? [])); outs.push(...(o.data ?? [])); aix.push(...(a.data ?? [])); views.push(...(v.data ?? []), ...(vh.data ?? []));
    msgs.push(...await all<M>((f) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer").in("conversation_id", ids).gte("created_at", new Date(Date.now() - 215 * 86_400_000).toISOString()).order("created_at").order("id").range(f, f + 999)));
    process.stdout.write(`\r  会話 ${Math.min(i + 15, cids.length)}/${cids.length}・通 ${msgs.length}`);
  }
  console.log("");
  const convBy = new Map(convs.map((c) => [c.id, c]));
  const appliedAt = new Map<string, number>(); for (const o of outs) if (o.applied_at) { const t = Date.parse(o.applied_at); const p = appliedAt.get(o.conversation_id); if (p == null || t < p) appliedAt.set(o.conversation_id, t); }
  const viewBy = new Map<string, number[]>(); for (const v of views) (viewBy.get(v.conversation_id) ?? viewBy.set(v.conversation_id, []).get(v.conversation_id)!).push(Date.parse(v.created_at));
  for (const o of outs) if (o.viewing_at) (viewBy.get(o.conversation_id) ?? viewBy.set(o.conversation_id, []).get(o.conversation_id)!).push(Date.parse(o.viewing_at));
  const msgBy = new Map<string, M[]>(); for (const m of msgs) (msgBy.get(m.conversation_id) ?? msgBy.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  const turns: MoodTurn[] = []; const skip: Record<string, number> = {}; const sk = (k: string) => { skip[k] = (skip[k] ?? 0) + 1; };
  for (const c of picked) {
    if (turns.length >= N) break;
    const conv = convBy.get(c.conversation_id);
    if (conv?.line_source_type === "group") { sk("グループ"); continue; }
    const list0 = msgBy.get(c.conversation_id) ?? [];
    const ap = appliedAt.get(c.conversation_id) ?? Infinity;
    let cut = list0.length;
    for (let i = 0; i < list0.length; i++) { const m = list0[i]; if (Date.parse(m.created_at) >= ap || (m.sender === "customer" && (applicationMaterialReason(m.text) || piiValueSignal(m.text)))) { cut = i; break; } }
    const list = list0.slice(0, cut);
    const j = list.findIndex((m) => m.sender === "customer" && Math.abs(Date.parse(m.created_at) - Date.parse(c.created_at)) < 2000);
    if (j < 0) { sk("切った後・通が無い"); continue; }
    let i0 = j; while (i0 - 1 >= 0 && list[i0 - 1].sender === "customer") i0--;
    const k = j + 1;
    if (k >= list.length || list[k].sender === "customer" || list[k].staff_writer !== "takeuchi") { sk("竹内さんの返事が無い"); continue; }
    let e = k; while (e + 1 < list.length && list[e + 1].sender !== "customer") e++;
    const resp = list.slice(k, e + 1);
    const names = addressNamesOf(list.filter((m) => m.sender !== "customer").map((m) => m.text ?? ""));
    const mask = (s: string | null) => maskExamText(s, conv?.customer_name ?? null, names);
    const customer = list.slice(i0, j + 1).map((m) => mask(m.text)).filter(Boolean).join("\n").slice(0, 600);
    if (!customer.trim() || /^\s*\[(?:スタンプ)\]\s*$/.test(customer)) { sk("空・スタンプ"); continue; }
    const context = list.slice(Math.max(0, i0 - 6), i0).map((m) => `${m.sender === "customer" ? "【お客様】" : m.is_aix_generated ? "【こちら・AIX】" : "【こちら】"}${mask(m.text).replace(/\s+/g, " ").slice(0, 220)}`);
    const takeuchi = resp.filter((m) => !m.is_aix_generated && (m.text ?? "").trim()).map((m) => mask(m.text).slice(0, 600));
    const bEnd = Date.parse(list[j].created_at), respEnd = Date.parse(resp[resp.length - 1].created_at) + 60_000;
    const ax = aix.filter((a) => a.conversation_id === c.conversation_id && Date.parse(a.sent_at!) >= bEnd - 60_000 && Date.parse(a.sent_at!) <= respEnd).map((a) => `${a.aix_type ?? "?"}${a.check_pattern ? `（${a.check_pattern}）` : ""}`);
    const aixTexts = resp.filter((m) => m.is_aix_generated && !/^\s*\[画像\]\s*$/.test(m.text ?? "")).map((m) => `AIX文: ${mask(m.text).replace(/\s+/g, " ").slice(0, 180)}`);
    if (!takeuchi.length && !ax.length && !aixTexts.length) { sk("中身なし"); continue; }
    const respLast = respEnd - 60_000;
    const nextCust = list0.slice(e + 1).find((m) => m.sender === "customer");
    turns.push({
      id: `${c.conversation_id.slice(0, 8)}-${list[i0].created_at.slice(0, 16)}`, cid: c.conversation_id, at: list[i0].created_at, scene: null,
      context, customer, takeuchi, aix: [...ax, ...aixTexts], draft: null, blocks: null, brain: null,
      after: {
        viewing14: (viewBy.get(c.conversation_id) ?? []).some((v) => v > respLast && v - respLast <= 14 * 86_400_000),
        applied30: ap !== Infinity && ap > respLast && ap - respLast <= 30 * 86_400_000,
        replied7: !!nextCust && Date.parse(nextCust.created_at) - respLast <= 7 * 86_400_000,
      },
    });
  }
  fs.writeFileSync(path.join(OUT, "turnread-turns-mood.json"), JSON.stringify(turns, null, 1));
  console.log(`竹内さんの番 ${turns.length}（会話 ${new Set(turns.map((x) => x.cid)).size}）・外した ${JSON.stringify(skip)}`);
  console.log(`  14日以内の内覧 ${turns.filter((x) => x.after.viewing14).length}・30日以内の申込 ${turns.filter((x) => x.after.applied30).length}・7日以内の返事 ${turns.filter((x) => x.after.replied7).length}`);
}

// ── LLM（DeepSeek・伏せた文だけ） ─────────────────────────────
const cost = { usd: 0, calls: 0, fail: 0 };
async function deepseekJson(sys: string, user: string, temperature: number): Promise<Record<string, unknown> | null> {
  if (process.env.LLM_TEST_MODE !== "deepseek-all") throw new Error("LLM_TEST_MODE=deepseek-all を付けて流す（test_protocol_brain.md）");
  const bad = piiValueSignal(user); if (bad) { console.warn(`  個人の値の疑い（${bad}）で送らない`); cost.fail++; return null; }
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../app/lib/llm-price");
  if (isDeepseekPeakAt(new Date()) && arg("allow-peak", "0") !== "1") throw new Error("DeepSeek の高い時間（平日 JST 10-13・15-19）なので止める");
  const model = process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature, max_tokens: 1200, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const pr = altPriceOf(model);
      if (pr && j.usage) cost.usd += (((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6) * (pr.peakDouble && isDeepseekPeakAt(new Date()) ? 2 : 1);
      cost.calls++;
      return JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")) as Record<string, unknown>;
    } catch (e) { if (attempt === 1) { cost.fail++; console.warn(`  失敗: ${e instanceof Error ? e.message : e}`); } }
  }
  return null;
}

export const TARGET_KINDS = ["送った物件", "持ち込み物件", "新着の1件", "探す条件", "費用・見積", "内覧の日・場所", "手続き・審査", "会社・店", "こちらの約束の結果", "その他"] as const;
export const INTENTS = [
  "内覧したい", "申込したい・抑えたい", "初期費用を抑えたい", "家賃を下げたい", "もっと良い部屋・別の物件も見たい", "もっと広い部屋", "設備の確かめ", "条件に合うかの確かめ",
  "空き・募集状況の確かめ", "費用の確かめ", "日程の調整・連絡", "手続き・審査の質問", "条件を伝える・言い直す", "気に入った・感想", "まだ刺さっていない・興味が薄い", "検討する・保留・相談", "断り・他で決めた", "お礼・了承", "その他",
] as const;

const GOLD_SYS = [
  "あなたは大阪の賃貸仲介の LINE を読む担当。お客様の一通に、スタッフ（竹内さん）が実際にどう返したかを見て、竹内さんがお客様の一通を何の事・何をしたい・どんな気持ちと読んだかを逆に読む。",
  "竹内さんの返信と AIX（定型の送信: 内覧調整・物件確認した・見積書送る 等）が正解の手掛かり。お客様が言っていない事は直前のこちらの送信と流れから決める（「ここ」「予算オーバー」「駐車場は？」の主語）。",
  "★target・intent・mindset はお客様の今の一通が指す物・したい事・気持ち。竹内さんがこの後に新しく送った物件・AIX をお客様の対象にしない（例: お客様「よろしくお願いします」→竹内さんが物件の束を送った＝対象は『直前のこちらの送信（条件を受けた・探すと言った）への了承』で kind=その他 か こちらの約束の結果、intent=お礼・了承）。",
  "★ours（こちら側の細かい所）は、この番より前に既にあった事だけ（直前の流れに見える送信・送った物件・AIX・約束・伝えた事）。竹内さんのこの返信・この番の AIX そのものは入れない。",
  "出す JSON:",
  `{"target":{"kind":"${TARGET_KINDS.join("|")}","detail":"細かい対象 25字以内（物件名・号室・どの設備・どの費用の項目・どの日の内覧・どの約束。言っていなければ文脈から決めた物）","how":"言った|文脈から"},`,
  ` "points":["竹内さんの返信・AIX が答えた要点を順番に 各20字以内（最大4）"],`,
  ` "omitted":["お客様の一通にあったが竹内さんがあえて答えなかった事（無ければ空）"],`,
  ` "intent":"${INTENTS.join("|")} から1つ（一番の意図）", "intent2":"2番目の意図か null",`,
  ` "mindset":"${MINDSET_STATES.join("|")} から1つ", "feeling":"気持ちの中身 25字以内（どの程度気に入っているか・何が不安か・迷いの中身）",`,
  ` "route":"返信|AIX|両方",`,
  ` "ours":[{"kind":"直前の送信|送った物件|AIX・ピッカー|開いている約束|既に伝えた情報","what":"竹内さんの返信が踏まえていた、こちら側の細かい所 30字以内（どの物件・何件・新着か束か・ピッカーの値・約束の中身と期限・既に伝えた事）"}]（最大4・無ければ空）}`,
  "出力は JSON だけ。",
].join("\n");

function turnText(t: Turn): string {
  return [
    `【直前の流れ（古い順）】\n${t.context.join("\n") || "（なし＝初回）"}`,
    `【お客様の今の一通】\n${t.customer}`,
    `【竹内さんの実際の返信】\n${t.takeuchi.join("\n―\n") || "（手の返信なし）"}`,
    `【その番に送った AIX】\n${t.aix.join("\n") || "（なし）"}`,
  ].join("\n\n");
}
type Gold = { target: { kind: string; detail: string; how: string }; points: string[]; omitted: string[]; intent: string; intent2: string | null; mindset: string; feeling: string; route: string; ours: Array<{ kind: string; what: string }> };
function normGold(o: Record<string, unknown> | null): Gold | null {
  if (!o) return null;
  const tg = (o.target ?? {}) as Record<string, unknown>;
  const kind = String(tg.kind ?? "その他"); const intent = String(o.intent ?? "その他"); const ms = String(o.mindset ?? "普通の依頼");
  return {
    target: { kind: (TARGET_KINDS as readonly string[]).includes(kind) ? kind : "その他", detail: String(tg.detail ?? "").slice(0, 40), how: String(tg.how ?? "") },
    points: Array.isArray(o.points) ? (o.points as unknown[]).map(String).slice(0, 4) : [], omitted: Array.isArray(o.omitted) ? (o.omitted as unknown[]).map(String).slice(0, 3) : [],
    intent: (INTENTS as readonly string[]).includes(intent) ? intent : "その他", intent2: o.intent2 ? String(o.intent2) : null,
    mindset: (MINDSET_STATES as readonly string[]).includes(ms) ? ms : "普通の依頼", feeling: String(o.feeling ?? "").slice(0, 40), route: String(o.route ?? ""),
    ours: Array.isArray(o.ours) ? (o.ours as Array<Record<string, unknown>>).map((x) => ({ kind: String(x?.kind ?? ""), what: String(x?.what ?? "").slice(0, 50) })).slice(0, 4) : [],
  };
}
const major = (xs: string[]) => { const c = new Map<string, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1])[0] ?? ["", 0]; };
type GoldRec = { votes: Gold[]; kind: string; kindVotes: number; intent: string; intentVotes: number; mindset: string; mindsetVotes: number; pick: Gold };

async function gold() {
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const lim = Number(arg("limit", String(turns.length))); const maxUsd = Number(arg("max-usd", "0.15"));
  const done: Record<string, GoldRec> = fs.existsSync(GOLD_FILE) ? JSON.parse(fs.readFileSync(GOLD_FILE, "utf8")) : {};
  const todo = turns.slice(0, lim).filter((t) => !done[t.id]);
  console.log(`正解: 済み ${Object.keys(done).length}・残り ${todo.length}`);
  const CONC = 5;
  for (let c = 0; c < todo.length; c += CONC) {
    if (cost.usd > maxUsd) { console.log(`上限 $${maxUsd} で止める`); break; }
    await Promise.all(todo.slice(c, c + CONC).map(async (t) => {
      const user = turnText(t);
      const votes: Gold[] = [];
      // 1票目は全部の欄・2〜3票目は多数決の3つだけ（同じ前置き＝作り置きが効く・出力を短く）
      const full = normGold(await deepseekJson(GOLD_SYS, user, 0)); if (full) votes.push(full);
      for (let v = 1; v < 3; v++) { const g = normGold(await deepseekJson(GOLD_SYS, `${user}\n\n【今回は {"target":{"kind":…},"intent":…,"mindset":…} の3つだけを JSON で出す（他の欄は出さない）】`, 0.7)); if (g) votes.push(full ? { ...full, target: { ...full.target, kind: g.target.kind }, intent: g.intent, mindset: g.mindset } : g); }
      if (!votes.length) return;
      const [kind, kv] = major(votes.map((x) => x.target.kind)); const [intent, iv] = major(votes.map((x) => x.intent)); const [ms, mv] = major(votes.map((x) => x.mindset));
      done[t.id] = { votes, kind, kindVotes: kv, intent, intentVotes: iv, mindset: ms, mindsetVotes: mv, pick: votes.find((x) => x.target.kind === kind) ?? votes[0] };
    }));
    fs.writeFileSync(GOLD_FILE, JSON.stringify(done, null, 1));
    process.stdout.write(`\r  ${Math.min(c + CONC, todo.length)}/${todo.length}・$${cost.usd.toFixed(3)}・${cost.calls} 回・失敗 ${cost.fail}`);
  }
  console.log(`\nDeepSeek ${cost.calls} 回・$${cost.usd.toFixed(4)}・失敗 ${cost.fail}`);
}

const JUDGE_SYS = [
  "あなたは賃貸仲介の LINE の採点係。お客様の一通について、正解の読み（竹内さんの実際の返信から逆に読んだ物）と、AI（ブレイン）の読み・AI の下書きを比べる。",
  "ブレインに届いた材料の欄（字数）: sentProps＝送った物件・promise＝開いている約束・aixHistory＝AIX の履歴・ledger＝行動台帳・history＝会話。0 や欄が無い＝届いていない。",
  "ta＝番ごとの『何について』の読み（about:物件・TURN_READ=log の記録・あれば cs より先にこれで対象を見る）、li＝潜在の読み（latent_intent）。",
  "ブレインの読みの欄: prop＝今の番の物件、ms＝気持ち|不安|迷い|決め手の残り、cs＝次の一手の方針（何について・何をするか）、q＝お客様の問い、action＝AIX の判断（null は返信）。",
  "出す JSON:",
  '{"target":"一致|一部|外れ|材料なし（ブレインが今の番の対象＝どの物件・どの話題をどう読んだか。物件の取り違え・送った物件と持ち込みの取り違え・話題の取り違えは外れ。号室だけ欠けは一部）",',
  ' "target_why":"外れ・一部の時の中身 30字（cs が今の一通でなく前の番の方針のままなら『前の方針のまま』で始める）",',
  ' ※正解の対象が物件でない（探す条件・お礼・約束の結果・内覧の日）時は prop でなく cs・q の話題で見る（prop=null だけで外れにしない）。',
  ' "intent":"一致|一部|外れ（ブレインの cs・q・ms から読めるお客様の意図が正解の意図と合うか。粗いだけ＝例: 設備の確かめを「質問」としか読んでいない は一部）",',
  ' "intent_why":"30字",',
  ' "draft_points_hit":正解の要点のうち下書きが答えた数, "draft_points_total":正解の要点の数, "draft_added":"下書きが足した、竹内さんに無い要点（無ければ空）",',
  ' "draft_dropped":"下書きが落とした竹内さんの要点（無ければ空）", "draft_target":"一致|外れ|下書きなし（下書きが答えている対象が正解の対象と同じか）",',
  ' "ours_blocks":"欄にある|欄に無い|なし（正解の『こちら側の細かい所』を運ぶ材料の欄＝送った物件は sentProps・約束は promise・AIX は aixHistory・伝えた事は history/ledger が字数ありで届いているか）",',
  ' "ours_brain":"読みに出た|一部|読みに出ていない|なし（その所がブレインの読み＝cs・prop・q に表れているか。cs は短い要約なので、食い違っていなければ『読みに出た』寄りに）", "ours_missing":"読みに出ていない・欄に無い こちら側の所 30字",',
  ' "draft_conflict":"なし|ピッカーと逆|送っていないのに送った|届いていないのに届いた|同じ日の2回目の挨拶|既に伝えた事の繰り返し|約束と食い違い|その他（下書きがこちら側の事実と食い違うか・下書きなしは なし）", "draft_conflict_why":"30字",',
  ' "miss_type":"対象の読み違い|意図の粗さ|気持ちの読み違い|こちら側の所の抜け|返信かAIXか|なし のうち一番大きい物",',
  ' "cause":"材料が届いていない|読み違い|AIXの番を返信に|なし（CLAUDE.md の3つ）"}',
  "出力は JSON だけ。",
].join("\n");

async function judge() {
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const golds: Record<string, GoldRec> = JSON.parse(fs.readFileSync(GOLD_FILE, "utf8"));
  const maxUsd = Number(arg("max-usd", "0.1"));
  const done: Record<string, Record<string, unknown>> = fs.existsSync(JUDGE_FILE) ? JSON.parse(fs.readFileSync(JUDGE_FILE, "utf8")) : {};
  const todo = turns.filter((t) => golds[t.id] && !done[t.id]);
  console.log(`比べる: 済み ${Object.keys(done).length}・残り ${todo.length}`);
  const CONC = 6;
  for (let c = 0; c < todo.length; c += CONC) {
    if (cost.usd > maxUsd) { console.log(`上限 $${maxUsd} で止める`); break; }
    await Promise.all(todo.slice(c, c + CONC).map(async (t) => {
      const g = golds[t.id];
      const user = [
        `【直前の流れ】\n${t.context.slice(-5).join("\n") || "（なし）"}`, `【お客様の今の一通】\n${t.customer}`,
        `【正解の読み】\n対象: ${g.kind}／${g.pick.target.detail}\n要点（竹内さんの順）: ${g.pick.points.join(" → ")}\n省いた事: ${g.pick.omitted.join("・") || "なし"}\n意図: ${g.intent}${g.pick.intent2 ? `（次に ${g.pick.intent2}）` : ""}\n気持ち: ${g.mindset}／${g.pick.feeling}\n返し方: ${g.pick.route}\nこちら側の細かい所: ${(g.pick.ours ?? []).map((x) => `${x.kind}＝${x.what}`).join("／") || "なし"}`,
        `【ブレインに届いた材料の欄】\n${t.blocks ? Object.entries(t.blocks).map(([k, v]) => `${k}:${v}`).join(" ") : "（記録なし）"}`,
        `【ブレインの読み】\n${t.brain ? JSON.stringify(t.brain) : "（記録なし）"}`,
        `【AI の下書き】\n${t.draft ?? "（下書きなし）"}`,
      ].join("\n\n");
      const o = await deepseekJson(JUDGE_SYS, user, 0);
      if (o) done[t.id] = o;
    }));
    fs.writeFileSync(JUDGE_FILE, JSON.stringify(done, null, 1));
    process.stdout.write(`\r  ${Math.min(c + CONC, todo.length)}/${todo.length}・$${cost.usd.toFixed(3)}`);
  }
  console.log(`\nDeepSeek ${cost.calls} 回・$${cost.usd.toFixed(4)}・失敗 ${cost.fail}`);
}

// ── ⑤ こちらの誘導先（11/11 竹内さん「こちらからの LINE は何に誘導しているのか細かい部分も把握できれば理解度上がる」・P0 ecd7b961 の子）
export const LEADS = ["内覧", "申込・抑える", "見積", "物件を送ってもらう", "条件を聞く", "新着の約束", "確認の約束", "関係をつなぐ", "誘導なし"] as const;
const LEAD_FILE = path.join(OUT, `turnread-lead${sfx}.json`);
const LEAD_SYS = [
  "あなたは賃貸仲介の LINE を読む担当。こちら（スタッフ）の送信が、お客様を何に誘導しているかを読む。",
  `誘導の種類: ${LEADS.join("|")}（関係をつなぐ＝何かあればご連絡・全力サポート 等）。強さ: 強い（はっきり誘う・日時や手順まで）|弱い（添えるだけ・お手隙の際に）|なし。`,
  "出す JSON:",
  '{"prev_lead":"直前のこちらの送信（お客様の今の一通の前）の誘導先","prev_strength":"強い|弱い|なし",',
  ' "answer":"応じた|断った・先送り|別の話|関係なし（お客様の今の一通が、その誘導への答えか）",',
  ' "next_lead":"竹内さんの実際の返信の誘導先", "next_step":"一段進めた|同じ誘導を繰り返した|別の誘導へ|誘導なし",',
  ' "draft_lead":"AI の下書きの誘導先（下書きなしは 誘導なし）", "draft_repeat":"はい|いいえ（下書きが直前と同じ誘導を、答えが来たのに繰り返しているか）",',
  ' "brain_reads_answer":"はい|いいえ|関係なし（ブレインの方針 cs が、お客様の一通を直前の誘導への答えとして扱っているか）"}',
  "出力は JSON だけ。",
].join("\n");
async function lead() {
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const lim = Number(arg("limit", String(turns.length))); const maxUsd = Number(arg("max-usd", "0.05"));
  const done: Record<string, { votes: Array<Record<string, string>>; m: Record<string, string> }> = fs.existsSync(LEAD_FILE) ? JSON.parse(fs.readFileSync(LEAD_FILE, "utf8")) : {};
  const todo = turns.slice(0, lim).filter((t) => !done[t.id]);
  const KEYS = ["prev_lead", "prev_strength", "answer", "next_lead", "next_step", "draft_lead", "draft_repeat", "brain_reads_answer"];
  for (let c = 0; c < todo.length; c += 5) {
    if (cost.usd > maxUsd) { console.log(`上限 $${maxUsd} で止める`); break; }
    await Promise.all(todo.slice(c, c + 5).map(async (t) => {
      const user = [turnText(t), `【AI の下書き】\n${t.draft ?? "（下書きなし）"}`, `【ブレインの方針 cs】\n${t.brain?.cs ?? "（なし）"}`].join("\n\n");
      const votes: Array<Record<string, string>> = [];
      for (let v = 0; v < 3; v++) { const o = await deepseekJson(LEAD_SYS, user, v === 0 ? 0 : 0.7); if (o) votes.push(Object.fromEntries(KEYS.map((k) => [k, String(o[k] ?? "")]))); }
      if (votes.length) done[t.id] = { votes, m: Object.fromEntries(KEYS.map((k) => [k, major(votes.map((x) => x[k]))[0]])) };
    }));
    fs.writeFileSync(LEAD_FILE, JSON.stringify(done, null, 1));
    process.stdout.write(`\r  ${Math.min(c + 5, todo.length)}/${todo.length}・$${cost.usd.toFixed(3)}`);
  }
  console.log(`\nDeepSeek ${cost.calls} 回・$${cost.usd.toFixed(4)}・失敗 ${cost.fail}`);
}

// ── 気持ちの細かい型（KB 542e92c9 の例をそのまま軸に・3票の多数決は base と object） ─────────────
export const MOOD_OBJECTS: Record<string, string[]> = {
  刺さっている: ["家賃", "広さ・間取り", "駅・場所", "新しさ・綺麗さ", "設備", "初期費用", "写真・見た目", "物件全体"],
  興味が薄い: ["予算が合わない", "場所が合わない", "広さ・間取りが合わない", "設備が合わない", "築年・古さ", "提案全体がまだ"],
  急いでいる: ["退去日・今の家", "転勤・就職・入学", "他社と同時進行", "理由は言っていない"],
  審査の不安: ["職業・収入", "勤続・転職", "保証人・保証会社", "過去の滞納・信用", "年齢・その他"],
  先に取られる不安: ["人気の物件", "入居日が先", "迷っている間"],
  抑えたい: ["申込したい", "仮押さえ・審査だけ先に", "決めたいが条件付き"],
  安くしたい: ["初期費用", "家賃", "礼金・敷金", "仲介手数料", "総額の確かめ"],
  内覧したい: ["日を出してきた", "見られるか聞いた", "複数まとめて見たい"],
  時間が無い: ["仕事で都合がつかない", "遠方", "先の日になる"],
  迷い: ["複数の物件で", "他社・他の物件と", "家族・同居人と相談", "時期・入居日で", "条件の優先で"],
  "不満・離れかけ": ["返事・対応", "物件が無い・合わない", "費用が高い", "他で決めた・見送り"],
  普通の依頼: ["了承・お礼（こちらの送信への受け）", "条件の提示・言い直し", "物件・設備の質問", "費用・手続きの質問", "日程の連絡", "持ち込み物件の確認"],
};
export const MOOD_DEGREES = ["弱い", "中", "強い"] as const;
const ROLES_T = ["受け止め・お礼", "共感", "安心させる", "障壁を下げる", "情報を答える", "約束する", "内覧へ", "申込・抑えへ", "物件を送る・探す", "関係をつなぐ"] as const;
const MOOD_SYS = [
  "あなたは大阪の賃貸仲介の LINE を読む担当。お客様の今の一通の気持ちを、お部屋探しに特化した細かい型で読む。竹内さん（スタッフ）の実際の返信・AIX も手掛かり（竹内さんがどう受けたかで気持ちを逆に読む）。",
  "★今の一通と直前のこちらの送信だけから読む。前の番の気持ちを持ち越さない（こちらの送信・約束への「よろしくお願いします」「ありがとうございます」だけなら 普通の依頼／了承・お礼）。",
  "base と object の組（base→選べる object）:",
  ...Object.entries(MOOD_OBJECTS).map(([b, os]) => `- ${b}: ${os.join("|")}`),
  "出す JSON:",
  `{"base":"上の base から1つ","object":"その base の object から1つ（どれにも当たらなければ 'その他:10字'）","degree":"${MOOD_DEGREES.join("|")}（気になる程度＝弱い・かなり＝中・決めたい／強く困っている＝強い）","quote":"気持ちが出ている言葉 20字",`,
  ` "roles":["竹内さんの返信・AIX の役目を順に（${ROLES_T.join("|")}）最大4"], "lead":"竹内さんの誘導先（${LEADS.join("|")}）"}`,
  "出力は JSON だけ。",
].join("\n");
type MoodLabel = { base: string; object: string; degree: string; quote: string; roles: string[]; lead: string };
function normMood(o: Record<string, unknown> | null): MoodLabel | null {
  if (!o) return null;
  const base = String(o.base ?? ""); if (!MOOD_OBJECTS[base]) return null;
  let object = String(o.object ?? ""); if (!MOOD_OBJECTS[base].includes(object) && !object.startsWith("その他")) object = "その他";
  return { base, object, degree: (MOOD_DEGREES as readonly string[]).includes(String(o.degree)) ? String(o.degree) : "中", quote: String(o.quote ?? "").slice(0, 30),
    roles: Array.isArray(o.roles) ? (o.roles as unknown[]).map(String).filter((r) => (ROLES_T as readonly string[]).includes(r)).slice(0, 4) : [], lead: String(o.lead ?? "") };
}
async function moodGold() {
  const file = arg("file", "turnread-turns-mood.json"); const outFile = path.join(OUT, `mood-gold-${file.replace(/^turnread-turns-?|\.json$/g, "") || "base"}.json`);
  const turns: Turn[] = JSON.parse(fs.readFileSync(path.join(OUT, file), "utf8"));
  const maxUsd = Number(arg("max-usd", "0.4"));
  const done: Record<string, { votes: MoodLabel[]; type: string; typeVotes: number; base: string; degree: string; pick: MoodLabel }> = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : {};
  const todo = turns.filter((t) => !done[t.id]);
  console.log(`${path.basename(outFile)}: 済み ${Object.keys(done).length}・残り ${todo.length}`);
  for (let c = 0; c < todo.length; c += 6) {
    if (cost.usd > maxUsd) { console.log(`上限 $${maxUsd} で止める`); break; }
    await Promise.all(todo.slice(c, c + 6).map(async (t) => {
      const user = turnText(t);
      const full = normMood(await deepseekJson(MOOD_SYS, user, 0));
      const votes: MoodLabel[] = full ? [full] : [];
      for (let v = 1; v < 3; v++) { const g = normMood(await deepseekJson(MOOD_SYS, `${user}\n\n【今回は {"base":…,"object":…,"degree":…} の3つだけを JSON で出す】`, 0.7)); if (g) votes.push(full ? { ...full, base: g.base, object: g.object, degree: g.degree } : g); }
      if (!votes.length) return;
      const [type, tv] = major(votes.map((x) => `${x.base}／${x.object}`));
      const pick = votes.find((x) => `${x.base}／${x.object}` === type) ?? votes[0];
      done[t.id] = { votes, type, typeVotes: tv, base: major(votes.map((x) => x.base))[0], degree: major(votes.map((x) => x.degree))[0], pick };
    }));
    fs.writeFileSync(outFile, JSON.stringify(done, null, 1));
    process.stdout.write(`\r  ${Math.min(c + 6, todo.length)}/${todo.length}・$${cost.usd.toFixed(3)}`);
  }
  console.log(`\nDeepSeek ${cost.calls} 回・$${cost.usd.toFixed(4)}・失敗 ${cost.fail}`);
}

function report() {
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const golds: Record<string, GoldRec> = JSON.parse(fs.readFileSync(GOLD_FILE, "utf8"));
  const judges: Record<string, Record<string, string | number>> = fs.existsSync(JUDGE_FILE) ? JSON.parse(fs.readFileSync(JUDGE_FILE, "utf8")) : {};
  const lim = Number(arg("limit", "9999"));
  const rows = turns.slice(0, lim).filter((t) => golds[t.id] && judges[t.id]);
  const cnt = (f: (x: typeof rows[number]) => string) => { const m = new Map<string, number>(); for (const r of rows) { const k = f(r); m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・"); };
  console.log(`番 ${rows.length}`);
  console.log(`正解の揺れ: 対象 3票一致 ${rows.filter((r) => golds[r.id].kindVotes === 3).length}・意図 ${rows.filter((r) => golds[r.id].intentVotes === 3).length}・気持ち ${rows.filter((r) => golds[r.id].mindsetVotes === 3).length}`);
  console.log(`①対象: ${cnt((r) => String(judges[r.id].target))}`);
  console.log(`③意図: ${cnt((r) => String(judges[r.id].intent))}`);
  const msOk = rows.filter((r) => (r.brain?.ms ?? "").split("|")[0] === golds[r.id].mindset).length;
  console.log(`③気持ち（ms の状態＝正解の状態）: 一致 ${msOk}/${rows.length}・記録なし ${rows.filter((r) => !r.brain?.ms).length}`);
  console.log(`  気持ちの外れの組（正解→ブレイン）: ${cnt((r) => { const b = (r.brain?.ms ?? "").split("|")[0] || "なし"; return b === golds[r.id].mindset ? "一致" : `${golds[r.id].mindset}→${b}`; })}`);
  const ph = rows.reduce((a, r) => a + Number(judges[r.id].draft_points_hit ?? 0), 0), pt = rows.reduce((a, r) => a + Number(judges[r.id].draft_points_total ?? 0), 0);
  const withDraft = rows.filter((r) => r.draft);
  console.log(`②要点（下書き）: 竹内さんの要点 ${pt} のうち下書きが答えた ${ph}（下書きのある番 ${withDraft.length}）・足した番 ${withDraft.filter((r) => String(judges[r.id].draft_added ?? "").trim()).length}・落とした番 ${withDraft.filter((r) => String(judges[r.id].draft_dropped ?? "").trim()).length}`);
  console.log(`  下書きの対象: ${cnt((r) => String(judges[r.id].draft_target))}`);
  console.log(`④こちら側の所: 材料の欄 ${cnt((r) => String(judges[r.id].ours_blocks))}／読み ${cnt((r) => String(judges[r.id].ours_brain))}`);
  console.log(`  正解のこちら側の所の種類: ${(() => { const m = new Map<string, number>(); for (const r of rows) for (const x of golds[r.id].pick.ours ?? []) m.set(x.kind, (m.get(x.kind) ?? 0) + 1); return [...m].map(([k, v]) => `${k} ${v}`).join("・"); })()}`);
  console.log(`  下書きの食い違い: ${cnt((r) => String(judges[r.id].draft_conflict))}`);
  if (fs.existsSync(LEAD_FILE)) {
    const L: Record<string, { m: Record<string, string> }> = JSON.parse(fs.readFileSync(LEAD_FILE, "utf8"));
    const lr = rows.filter((r) => L[r.id]);
    const lc = (k: string) => { const m = new Map<string, number>(); for (const r of lr) { const v = L[r.id].m[k]; m.set(v, (m.get(v) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join("・"); };
    console.log(`⑤誘導（${lr.length}番）: 直前の誘導 ${lc("prev_lead")}`);
    console.log(`  お客様の一通は: ${lc("answer")}／ブレインが答えとして読んだ: ${lc("brain_reads_answer")}`);
    console.log(`  竹内さんの次: ${lc("next_step")}／下書きの誘導＝竹内さんと同じ ${lr.filter((r) => r.draft && L[r.id].m.draft_lead === L[r.id].m.next_lead).length}/${lr.filter((r) => r.draft).length}・下書きが同じ誘導を繰り返した ${lr.filter((r) => L[r.id].m.draft_repeat === "はい").length}`);
  }
  // 2026-11-11 TURN_READ=log（既定）の記録 digest.ta（turn_contract の about）と正解の対象の種類を決まった計算で比べる（毎朝の数え）
  const ABOUT_KIND: Record<string, string[]> = {
    property_equipment: ["送った物件", "持ち込み物件", "新着の1件"], property_cost: ["費用・見積", "送った物件", "持ち込み物件"], vacancy: ["送った物件", "持ち込み物件", "新着の1件"],
    viewing_day: ["内覧の日・場所"], procedure: ["手続き・審査"], company: ["会社・店"], search_condition: ["探す条件"], reaction_to_sent: ["送った物件", "新着の1件", "こちらの約束の結果"],
    other_party: ["その他"], self: ["その他", "こちらの約束の結果"], other: ["その他", "こちらの約束の結果"],
  };
  const withTa = rows.filter((r) => r.brain?.ta?.length);
  if (withTa.length) {
    const hit = withTa.filter((r) => (r.brain!.ta ?? []).some((a) => (ABOUT_KIND[a.split(":")[0]] ?? []).includes(golds[r.id].kind)));
    console.log(`①対象（digest.ta の about＝正解の種類・決まった計算）: ${hit.length}/${withTa.length}（ta のある番）・ta の無い番 ${rows.length - withTa.length}`);
    console.log(`  外れの組（正解→about）: ${cnt((r) => (withTa.includes(r) && !hit.includes(r)) ? `${golds[r.id].kind}→${(r.brain!.ta ?? []).map((a) => a.split(":")[0]).join("+")}` : "-")}`);
  }
  console.log(`外れの型: ${cnt((r) => String(judges[r.id].miss_type))}`);
  console.log(`原因: ${cnt((r) => String(judges[r.id].cause))}`);
  console.log(`正解の対象の種類: ${cnt((r) => golds[r.id].kind)}`);
  console.log(`正解の意図: ${cnt((r) => golds[r.id].intent)}`);
  const show = arg("show", "");
  if (show) for (const r of rows.filter((x) => String(judges[x.id].miss_type) === show || show === "all").slice(0, Number(arg("show-n", "6")))) {
    const g = golds[r.id], j = judges[r.id];
    console.log(`\n── ${r.id}（${r.scene}）\n客: ${r.customer.replace(/\s+/g, " ").slice(0, 160)}\n竹内: ${r.takeuchi.join(" ／ ").replace(/\s+/g, " ").slice(0, 200)}${r.aix.length ? `\nAIX: ${r.aix.join("・").slice(0, 120)}` : ""}\n正解: 対象 ${g.kind}／${g.pick.target.detail}・意図 ${g.intent}・気持ち ${g.mindset}／${g.pick.feeling}・要点 ${g.pick.points.join("→")}\nブレイン: prop=${r.brain?.prop}・ms=${r.brain?.ms}・cs=${(r.brain?.cs ?? "").slice(0, 90)}・action=${r.brain?.action}\n下書き: ${(r.draft ?? "").replace(/\s+/g, " ").slice(0, 160)}\n判定: 対象 ${j.target}（${j.target_why}）・意図 ${j.intent}（${j.intent_why}）・足した ${j.draft_added}・落とした ${j.draft_dropped}・④ ${j.ours_brain}（${j.ours_missing}）・食い違い ${j.draft_conflict}（${j.draft_conflict_why}）・型 ${j.miss_type}・原因 ${j.cause}\nこちら側（正解）: ${(g.pick.ours ?? []).map((x) => `${x.kind}＝${x.what}`).join("／")}`);
  }
}

// ── 気持ちの当たりの前後（部品の試し: 本物のブレインは回さず、ブレインの気持ちの欄の指示と、本番と同じ形の前回の気持ちを渡して読ませる）
//   before: MINDSET_BRAIN_FIELD＋プロファイルの温度感（前回）＋【気持ちの流れ】の前回までの気持ち
//   after : 同じ＋turn_read の欄（mood の細かい型・持ち越さない一文）・お礼了承だけの一通は ackOnly の注記（customer-memo-server と同じ分け方）
async function moodProbe() {
  const variant = arg("variant", "before");
  const { MINDSET_BRAIN_FIELD } = await import("../app/lib/customer-mindset");
  const { TURN_READ_BRAIN_FIELD } = await import("../app/lib/turn-read");
  const { buildMoodFlowNote } = await import("../app/lib/customer-mood-flow");
  const { isAckOnlyTurn } = await import("../app/lib/ack-topic-scope");
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const prev: Record<string, { now: string | null; prev: string[] }> = JSON.parse(fs.readFileSync(path.join(OUT, "turnread-prevms.json"), "utf8"));
  const outFile = path.join(OUT, `mood-probe-${variant}.json`);
  const done: Record<string, { state: string; base: string | null; object: string | null }> = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : {};
  const sys = [
    "あなたは賃貸仲介のブレイン（今回の発言の層）。お客様の今の一通の気持ちを読み、JSON だけを出す。",
    `出す項目: ${MINDSET_BRAIN_FIELD}${variant.startsWith("after") ? `、${TURN_READ_BRAIN_FIELD}` : ""}`,
  ].join("\n");
  const todo = turns.filter((t) => !done[t.id]);
  for (let c = 0; c < todo.length; c += 8) {
    if (cost.usd > Number(arg("max-usd", "0.08"))) break;
    await Promise.all(todo.slice(c, c + 8).map(async (t) => {
      const p = prev[t.id]?.prev ?? [];
      const ack = variant.startsWith("after") && isAckOnlyTurn(t.customer);
      const flow = buildMoodFlowNote({ changes: [], signals: {}, reaction: null } as never, { prevEmotions: p, ackOnly: ack });
      const flowAlways = flow || (p.length ? `\n【気持ちの流れ（決まった計算・材料）】\n- 前回までの気持ち（ブレインの判断・古い→新しい）: ${p.join("→")}\n→ 今回の emotion は言葉だけでなくこの流れ（前回からの変化）も見て決める` : "");
      const user = [p.length ? `【顧客プロファイル】\n- 温度感: ${p[p.length - 1]}` : "", `【直前の流れ】\n${t.context.join("\n")}`, ack ? flow : flowAlways, `【今回の発言】\n${t.customer}`].filter(Boolean).join("\n\n");
      const o = await deepseekJson(sys, user, 0);
      if (!o) return;
      const ms = (o.mindset ?? {}) as Record<string, unknown>; const tr = (o.turn_read ?? {}) as Record<string, unknown>; const md = (tr.mood ?? {}) as Record<string, unknown>;
      done[t.id] = { state: String(ms.state ?? ""), base: md.base ? String(md.base) : null, object: md.object ? String(md.object) : null };
    }));
    fs.writeFileSync(outFile, JSON.stringify(done, null, 1));
  }
  console.log(`${variant}: ${Object.keys(done).length} 番・DeepSeek ${cost.calls} 回・$${cost.usd.toFixed(4)}`);
}

// 100番それぞれの「前回までのブレインの気持ち」（その番の判断より前の判断の digest.ms の状態・古い→新しい・最大3）→ turnread-prevms.json
async function prevMs() {
  const turns: Turn[] = JSON.parse(fs.readFileSync(TURNS_FILE, "utf8"));
  const out: Record<string, { now: string | null; prev: string[] }> = {};
  for (const t of turns) {
    const { data: lw } = await sb.from("line_watch_turns").select("decision_id").eq("conversation_id", t.cid).eq("customer_turn_at", t.at).limit(1);
    const did = lw?.[0]?.decision_id; if (!did) continue;
    const { data: d } = await sb.from("brain_decision_logs").select("created_at, digest").eq("id", did).limit(1);
    if (!d?.[0]) continue;
    const { data: p } = await sb.from("brain_decision_logs").select("digest").eq("conversation_id", t.cid).lt("created_at", d[0].created_at).order("created_at", { ascending: false }).limit(3);
    const st = (g: unknown) => { const v = (g as Record<string, unknown> | null)?.ms; return typeof v === "string" ? v.split("|")[0] : ""; };
    out[t.id] = { now: st(d[0].digest) || null, prev: (p ?? []).map((x) => st(x.digest)).filter(Boolean).reverse() };
  }
  fs.writeFileSync(path.join(OUT, "turnread-prevms.json"), JSON.stringify(out, null, 1));
  console.log(`前回の気持ち ${Object.keys(out).length} 番・前回ありが ${Object.values(out).filter((x) => x.prev.length).length}`);
}

async function main() {
  if (PHASE === "prevms") return prevMs();
  if (PHASE === "build") return build();
  if (PHASE === "mood-build") return buildMood();
  if (PHASE === "report") return report();
  // LLM を呼ぶ段は共通の入口を通す（test_protocol_brain.md 5）。会話 id は付けない＝伏せた文だけを DeepSeek に送る読み取りの監査
  const { setupLlmTest } = await import("./lib/llm-test-harness");
  const h = await setupLlmTest(`audit-turn-read-${PHASE}`);
  try { if (PHASE === "gold") await gold(); else if (PHASE === "judge") await judge(); else if (PHASE === "lead") await lead(); else if (PHASE === "mood-gold") await moodGold(); else if (PHASE === "mood-probe") await moodProbe(); } finally { await h.finish(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
