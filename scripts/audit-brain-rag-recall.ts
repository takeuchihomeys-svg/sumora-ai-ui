// scripts/audit-brain-rag-recall.ts — ブレインのナレッジ検索（match_reply_knowledge）の当たりと混ざりを、本番の番で測る（読むだけ・DB に書かない・LLM なし・埋め込みだけ）
//
// 2026-10-27 節約②（P0 1bf03f2c「要る材料を RAG で的確に取りに行く・当たり具合を測ってから使う」・汎用の点検表 803ff07c ⑩）:
//   正解のラベルは作らず、その番でスタッフが実際に送った文（返信・AIX の文）を正解の代わりにする。
//   取れたナレッジとスタッフの文の埋め込みの近さ（上位の最大・平均）＝当たり、
//   会話の段階が違うナレッジ・同じ会話の手本から作られたナレッジの割合＝混ざり、渡す字数＝費用 を、問いの作り方の案ごとに比べる。
//   案 prod: 今の本番の問い（会話の段階＋直前のスタッフの文＋今回のお客様の連投・1本・上位 k）
//   案 split: 問いを分けて引く（お客様の今の発言だけ／状況＝段階＋直前のスタッフの文／発言を文ごと最大3本）→ RRF で合わせ、重要度で並べて上位 k
//
//   npx tsx --env-file=.env.local scripts/audit-brain-rag-recall.ts [--n=50] [--days=30] [--k=12] [--show=5]
import { createClient } from "@supabase/supabase-js";
import { generateEmbedding } from "../app/lib/knowledge-utils";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const N = Number(arg("n", "50")), DAYS = Number(arg("days", "30")), K = Number(arg("k", "12")), SHOW = Number(arg("show", "0"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Row = { id: string; content: string; conversation_state: string | null; importance: number; similarity: number; title?: string | null };

const vec = (v: unknown): number[] | null => (Array.isArray(v) ? (v as number[]) : typeof v === "string" ? JSON.parse(v) : null);
const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };

async function pickTurns(): Promise<Array<{ convId: string; status: string | null; customer: string; lastStaff: string; gold: string; at: string }>> {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data: convs } = await sb.from("conversations").select("id, status").gte("updated_at", since).limit(600);
  // 見本5件で直した: 申込以降（対象外）を外す・正解はスタッフの手打ちの文だけ（AIX の文はナレッジ検索の物差しに合わない）
  const POST = new Set(["applying", "screening", "closed_won", "contract", "closed_lost"]);
  const pool = ((convs ?? []) as Array<{ id: string; status: string | null }>).filter((c) => !isTestConversation(c.id) && !POST.has(c.status ?? ""));
  const out: Array<{ convId: string; status: string | null; customer: string; lastStaff: string; gold: string; at: string }> = [];
  for (const c of pool) {
    if (out.length >= N) break;
    const { data: ms } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").eq("conversation_id", c.id).gte("created_at", since).order("created_at", { ascending: true }).limit(400);
    const msgs = ((ms ?? []) as Msg[]).filter((m) => (m.text ?? "").trim() && !/^\[(画像|スタンプ|動画|ファイル)\]$/.test((m.text ?? "").trim()));
    // 後ろから: お客様の連投 → その後3時間以内のスタッフの文（返信・AIX の文）がある最後の番
    for (let i = msgs.length - 1; i > 0; i--) {
      if (msgs[i].sender === "customer") continue;
      // i はスタッフ。直前の連投の終わり j
      let j = i - 1; if (msgs[j].sender !== "customer") continue;
      if (Date.parse(msgs[i].created_at) - Date.parse(msgs[j].created_at) > 3 * 3600_000) continue;
      let s = j; while (s - 1 >= 0 && msgs[s - 1].sender === "customer") s--;
      const customer = msgs.slice(s, j + 1).map((m) => m.text).join("\n");
      let e = i; const gold: string[] = []; while (e < msgs.length && msgs[e].sender !== "customer") { if (!msgs[e].is_aix_generated) gold.push(msgs[e].text ?? ""); e++; }
      const lastStaff = [...msgs.slice(0, s)].reverse().find((m) => m.sender !== "customer")?.text ?? "";
      if (customer.length < 4 || gold.join("").length < 15) continue;
      out.push({ convId: c.id, status: c.status, customer, lastStaff, gold: gold.join("\n").slice(0, 1500), at: msgs[j].created_at });
      break;
    }
  }
  return out;
}

async function knowledge(q: string, k: number): Promise<Row[]> {
  const e = await generateEmbedding(q);
  if (!e) return [];
  const { data, error } = await sb.rpc("match_reply_knowledge", { query_embedding: e, match_count: k, min_importance: 8, boost_state: null });
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

function rrf(lists: Row[][], k: number): Row[] {
  const score = new Map<string, { row: Row; s: number }>();
  for (const l of lists) l.forEach((r, i) => { const cur = score.get(r.id) ?? { row: r, s: 0 }; cur.s += 1 / (60 + i); score.set(r.id, cur); });
  return [...score.values()].sort((a, b) => b.s - a.s || b.row.importance - a.row.importance).slice(0, k).map((x) => x.row);
}

async function main() {
  const turns = await pickTurns();
  console.log(`番 ${turns.length}（${DAYS}日・テストの会話を除く・1会話1番）・上位 k=${K}`);
  const embCache = new Map<string, number[] | null>();
  const embOf = async (ids: string[]) => {
    const need = ids.filter((id) => !embCache.has(id));
    if (need.length) { const { data } = await sb.from("ai_reply_knowledge").select("id, embedding, source_example_id").in("id", need); for (const r of (data ?? []) as Array<{ id: string; embedding: unknown }>) embCache.set(r.id, vec(r.embedding)); }
    return ids.map((id) => embCache.get(id) ?? null);
  };
  const srcConv = new Map<string, string | null>();
  const convOfRows = async (ids: string[]) => {
    const need = ids.filter((id) => !srcConv.has(id));
    if (need.length) {
      const { data } = await sb.from("ai_reply_knowledge").select("id, source_example_id").in("id", need);
      const ex = ((data ?? []) as Array<{ id: string; source_example_id: string | null }>);
      const exIds = ex.map((r) => r.source_example_id).filter(Boolean) as string[];
      const { data: exs } = exIds.length ? await sb.from("ai_reply_examples").select("id, conversation_id").in("id", exIds) : { data: [] };
      const m = new Map(((exs ?? []) as Array<{ id: string; conversation_id: string | null }>).map((x) => [x.id, x.conversation_id]));
      for (const r of ex) srcConv.set(r.id, r.source_example_id ? (m.get(r.source_example_id) ?? null) : null);
    }
    return ids.map((id) => srcConv.get(id) ?? null);
  };
  type Agg = { max: number[]; mean: number[]; best1: number[]; otherState: number[]; postApply: number[]; sameConv: number[]; chars: number[] };
  // 会話の状態の名前が付いた行だけ「別の段階」を数える（TPO の日本語・AIX の種類の行は数えない）
  const STATUS_VOCAB = new Set(["hearing", "proposing", "viewing", "applying", "closed_won", "screening", "property_recommendation", "first_reply", "condition_hearing"]);
  const agg: Record<string, Agg> = {};
  const add = (name: string, v: Partial<Record<keyof Agg, number>>) => { const a = (agg[name] ??= { max: [], mean: [], best1: [], otherState: [], postApply: [], sameConv: [], chars: [] }); for (const [k2, x] of Object.entries(v)) if (x != null && Number.isFinite(x)) a[k2 as keyof Agg].push(x as number); };
  let shown = 0;
  for (const t of turns) {
    const gold = await generateEmbedding(t.gold); if (!gold) continue;
    const prodQ = [`${t.status ?? ""}:`, t.lastStaff ? `[前返信]${t.lastStaff.slice(0, 150)}` : null, `[顧客]${t.customer.slice(0, 600)}`].filter(Boolean).join(" ").slice(0, 1500);
    const sentences = t.customer.split(/[\n。？?！!]+/).map((s) => s.trim()).filter((s) => s.length >= 6).slice(0, 3);
    // 段階が違う行（会話の状態の名前が付いた行で、今の状態と違う）・申込以降の行（申込前の番）を落とす
    const keep = (r: Row) => !(r.conversation_state && STATUS_VOCAB.has(r.conversation_state) && t.status && r.conversation_state !== t.status);
    const variants: Record<string, () => Promise<Row[]>> = {
      prod: () => knowledge(prodQ, K),
      prodFilter: async () => (await knowledge(prodQ, 30)).filter(keep).slice(0, K),
      prodMix: async () => rrf(await Promise.all([knowledge(prodQ, 30), knowledge(`[顧客]${t.customer.slice(0, 600)}`, 30)]), 60).filter(keep).slice(0, K),
      split: async () => rrf(await Promise.all([knowledge(`[顧客]${t.customer.slice(0, 600)}`, K), knowledge(`${t.status ?? ""}: ${t.lastStaff ? `[前返信]${t.lastStaff.slice(0, 150)}` : ""}`, K), ...sentences.map((s) => knowledge(`${t.status ?? ""}: [顧客]${s}`, K))]), K),
    };
    for (const [name, fn] of Object.entries(variants)) {
      const rows = await fn();
      const embs = await embOf(rows.map((r) => r.id));
      const sims = embs.map((e) => (e ? cos(e, gold) : NaN)).filter(Number.isFinite);
      const convs = await convOfRows(rows.map((r) => r.id));
      add(name, {
        max: sims.length ? Math.max(...sims) : NaN, mean: sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : NaN,
        best1: sims.length ? sims[0] : NaN,
        otherState: rows.length ? rows.filter((r) => r.conversation_state && STATUS_VOCAB.has(r.conversation_state) && t.status && r.conversation_state !== t.status).length / rows.length : NaN,
        postApply: rows.length ? rows.filter((r) => r.conversation_state === "applying" || r.conversation_state === "closed_won").length / rows.length : NaN,
        sameConv: rows.length ? convs.filter((c) => c === t.convId).length / rows.length : NaN,
        chars: rows.reduce((a, r) => a + (r.content?.length ?? 0), 0),
      });
      if (shown < SHOW) console.log(`\n[見本 ${shown + 1}・${name}] 段階=${t.status} 顧客「${t.customer.slice(0, 50).replace(/\n/g, " ")}」\n  正解（スタッフ）「${t.gold.slice(0, 70).replace(/\n/g, " ")}」\n  取れた上位3: ${rows.slice(0, 3).map((r, i) => `(${sims[i]?.toFixed(3)})${(r.title ?? r.content).slice(0, 40).replace(/\n/g, " ")}`).join(" ｜ ")}`);
    }
    if (shown < SHOW) shown++;
  }
  const avg = (a: number[]) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length) : NaN);
  console.log(`\n案 | 番 | 近さ最大 | 近さ平均 | 1位の近さ | 別の段階の割合 | 申込以降の行 | 同じ会話の手本の割合 | 渡す字数`);
  for (const [name, a] of Object.entries(agg)) console.log(`${name} | ${a.max.length} | ${avg(a.max).toFixed(3)} | ${avg(a.mean).toFixed(3)} | ${avg(a.best1).toFixed(3)} | ${(avg(a.otherState) * 100).toFixed(0)}% | ${(avg(a.postApply) * 100).toFixed(0)}% | ${(avg(a.sameConv) * 100).toFixed(1)}% | ${Math.round(avg(a.chars))}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
