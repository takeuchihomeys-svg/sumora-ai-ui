// scripts/compare-models.ts
// 「今の Claude」と「DeepSeek」に**同じ材料**を渡して文を作らせ、実送信と突き合わせて質を比べる。
//
// 2026-09-19 竹内「これ文に質は問題ないかな？今のと比べるとどのレベルか」
//
// 設計知見に従った作り:
//  ・「毎回『実データに何件あるか』を手で数えていた作業は道具にする — 生成文と実送信を同じ整形で突き合わせる」
//    → phrase-shape.ts で述部を取り、実送信365日に何件あるかで測る（0件＝こちらが使ったことのない言い回し＝創作）
//  ・「本番検証は画面が渡すのと同じ形で渡す」→ 材料は実データ（会話・条件・実際に送った返信）から取る
//  ・「線を引いたら外れた側の中身を必ず読む」→ 件数だけでなく生成文そのものを並べて出す
//  ・共通の前置きは**本物**（AIX_SHARED_SYSTEM_PREFIX ≈41.7k tokens）を使う
//    → 本番と同じ大きさでプロンプトキャッシュが効くかも同時に測れる
//
// 実行: npx tsx --env-file=.env.local scripts/compare-models.ts [--cases=6]
export {};
import { createClient } from "@supabase/supabase-js";
import { AIX_SHARED_SYSTEM_PREFIX } from "../app/lib/aix-system-blocks";
import { extractPhraseShapes } from "../app/lib/phrase-shape";
import { createMasker } from "../app/lib/pii-pseudonym";
import { DEEPSEEK_ENDPOINT } from "../app/lib/llm-alt-provider";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const dsKey = process.env.DEEPSEEK_API_KEY;
const anKey = process.env.ANTHROPIC_API_KEY;
if (!url || !sbKey) { console.error("Supabase の設定が未設定"); process.exit(2); }
if (!dsKey) { console.error("DEEPSEEK_API_KEY が未設定"); process.exit(2); }
if (!anKey) { console.error("ANTHROPIC_API_KEY が未設定（今の Claude と比べられない）"); process.exit(2); }
const sb = createClient(url, sbKey);

const CASES = Number(process.argv.find((a) => a.startsWith("--cases="))?.slice(8) ?? 6);
const DS_MODEL = "deepseek-v4-pro";
const CL_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 600;

type Case = { id: string; conversationId: string | null; state: string; customerMessage: string; sentReply: string };

/** 実送信365日の言い回し（述部 → 件数）。これが「こちらが実際に使う言い方」の正解集合 */
async function loadSentPhrases(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let page = 0; ; page++) {
    const { data, error } = await sb.from("messages").select("text")
      .eq("sender", "staff").gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) { console.error("messages 取得失敗:", error.message); break; }
    if (!data || data.length === 0) break;
    for (const m of data as Array<{ text: string | null }>) {
      for (const p of extractPhraseShapes(m.text ?? "")) counts.set(p.predicate, (counts.get(p.predicate) ?? 0) + 1);
    }
    if (data.length < 1000) break;
  }
  return counts;
}

async function loadCases(): Promise<Case[]> {
  const { data } = await sb.from("ai_reply_examples")
    .select("id, conversation_id, conversation_state, customer_message, sent_reply")
    .not("customer_message", "is", null).not("sent_reply", "is", null)
    .order("created_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as Array<{ id: string; conversation_id: string | null; conversation_state: string | null; customer_message: string | null; sent_reply: string | null }>;
  return rows
    .filter((r) => (r.customer_message ?? "").length > 15 && (r.sent_reply ?? "").length > 30 && !(r.customer_message ?? "").startsWith("[画像]"))
    .slice(0, CASES)
    .map((r) => ({
      id: r.id, conversationId: r.conversation_id, state: r.conversation_state ?? "proposing",
      customerMessage: r.customer_message!, sentReply: r.sent_reply!,
    }));
}

async function callClaude(system: string, user: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": anKey!, "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" },
    body: JSON.stringify({
      model: CL_MODEL, max_tokens: MAX_TOKENS, thinking: { type: "disabled" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as { content?: Array<{ type: string; text?: string }>; usage?: Record<string, number> };
  return { text: j.content?.find((b) => b.type === "text")?.text?.trim() ?? "", usage: j.usage ?? {} };
}

async function callDeepSeek(system: string, user: string) {
  const res = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${dsKey}` },
    body: JSON.stringify({
      model: DS_MODEL, max_tokens: MAX_TOKENS, thinking: { type: "disabled" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, number> };
  return { text: j.choices?.[0]?.message?.content?.trim() ?? "", usage: j.usage ?? {} };
}

/** 生成文を実送信と突き合わせる */
function score(text: string, sent: Map<string, number>) {
  const shapes = extractPhraseShapes(text);
  const unseen = shapes.filter((s) => (sent.get(s.predicate) ?? 0) === 0);
  return { phrases: shapes.length, unseen: unseen.length, unseenSamples: unseen.slice(0, 3).map((u) => u.clause) };
}

/** 実際に送った返信との「言い回しの重なり」（述部がどれだけ一致するか） */
function overlapWithTruth(text: string, truth: string): number {
  const a = new Set(extractPhraseShapes(text).map((s) => s.predicate));
  const b = new Set(extractPhraseShapes(truth).map((s) => s.predicate));
  if (b.size === 0) return 0;
  let hit = 0;
  for (const p of b) if (a.has(p)) hit++;
  return Math.round((100 * hit) / b.size);
}

async function main() {
  console.log("── 実送信365日の言い回しを読み込み中…");
  const sent = await loadSentPhrases();
  console.log(`  言い回し ${sent.size} 種類`);

  const cases = await loadCases();
  console.log(`── 実データ ${cases.length} 件で比較（共通の前置き ${Math.round(AIX_SHARED_SYSTEM_PREFIX.length / 1000)}k字＝本番と同じ大きさ）\n`);

  const agg = { cl: { unseen: 0, phrases: 0, len: 0, overlap: 0 }, ds: { unseen: 0, phrases: 0, len: 0, overlap: 0 } };
  const cacheLog: string[] = [];

  for (const [i, c] of cases.entries()) {
    const m = createMasker({ conversationId: c.conversationId ?? c.id, customerName: null });
    const user = [
      `【会話の状態】${c.state}`,
      `【お客様の最新メッセージ】`,
      m.mask(c.customerMessage),
      ``,
      `上のお客様のメッセージに対する、スモラからの LINE 返信を1通だけ作ってください。`,
      `返信の本文だけを出力し、前置き・説明・見出しは一切書かないでください。`,
    ].join("\n");

    let cl, ds;
    try { cl = await callClaude(AIX_SHARED_SYSTEM_PREFIX, user); }
    catch (e) { console.log(`  [${i + 1}] Claude 失敗: ${e instanceof Error ? e.message : e}`); continue; }
    try { ds = await callDeepSeek(AIX_SHARED_SYSTEM_PREFIX, user); }
    catch (e) { console.log(`  [${i + 1}] DeepSeek 失敗: ${e instanceof Error ? e.message : e}`); continue; }

    const sc = score(m.unmask(cl.text), sent);
    const sd = score(m.unmask(ds.text), sent);
    const oc = overlapWithTruth(m.unmask(cl.text), c.sentReply);
    const od = overlapWithTruth(m.unmask(ds.text), c.sentReply);
    agg.cl.unseen += sc.unseen; agg.cl.phrases += sc.phrases; agg.cl.len += cl.text.length; agg.cl.overlap += oc;
    agg.ds.unseen += sd.unseen; agg.ds.phrases += sd.phrases; agg.ds.len += ds.text.length; agg.ds.overlap += od;
    cacheLog.push(`  [${i + 1}] Claude read=${cl.usage.cache_read_input_tokens ?? 0} write=${cl.usage.cache_creation_input_tokens ?? 0} / DeepSeek 一致=${ds.usage.prompt_cache_hit_tokens ?? 0} 不一致=${ds.usage.prompt_cache_miss_tokens ?? 0}`);

    console.log(`━━ [${i + 1}] お客様: ${JSON.stringify(m.mask(c.customerMessage).slice(0, 56))}`);
    console.log(`  実際に送った文 : ${JSON.stringify(c.sentReply.slice(0, 70))}`);
    console.log(`  今の Claude    : ${JSON.stringify(m.unmask(cl.text).slice(0, 70))}`);
    console.log(`     言い回し ${sc.phrases}個 / 実送信0件 ${sc.unseen}個 / 実送信との重なり ${oc}%`);
    if (sc.unseenSamples.length) console.log(`     0件の例: ${sc.unseenSamples.map((s) => JSON.stringify(s)).join(" ")}`);
    console.log(`  DeepSeek V4Pro : ${JSON.stringify(m.unmask(ds.text).slice(0, 70))}`);
    console.log(`     言い回し ${sd.phrases}個 / 実送信0件 ${sd.unseen}個 / 実送信との重なり ${od}%`);
    if (sd.unseenSamples.length) console.log(`     0件の例: ${sd.unseenSamples.map((s) => JSON.stringify(s)).join(" ")}`);
    console.log("");
  }

  const n = cases.length || 1;
  console.log("━━━━━━━━━━ まとめ ━━━━━━━━━━");
  console.log(`                      今の Claude   DeepSeek V4-Pro`);
  console.log(`  言い回しの数（平均）  ${(agg.cl.phrases / n).toFixed(1).padStart(8)}   ${(agg.ds.phrases / n).toFixed(1).padStart(10)}`);
  console.log(`  実送信0件（平均）★    ${(agg.cl.unseen / n).toFixed(1).padStart(8)}   ${(agg.ds.unseen / n).toFixed(1).padStart(10)}   ← 少ないほど「うちの言い方」`);
  console.log(`  実送信との重なり★     ${(agg.cl.overlap / n).toFixed(0).padStart(7)}%   ${(agg.ds.overlap / n).toFixed(0).padStart(9)}%   ← 高いほど実際に送った文に近い`);
  console.log(`  文字数（平均）        ${(agg.cl.len / n).toFixed(0).padStart(8)}   ${(agg.ds.len / n).toFixed(0).padStart(10)}`);
  console.log(`\n── プロンプトキャッシュ（本番と同じ ${Math.round(AIX_SHARED_SYSTEM_PREFIX.length / 1000)}k字の前置き）`);
  for (const l of cacheLog) console.log(l);
}

main().catch((e) => { console.error(e); process.exit(1); });
