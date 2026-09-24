// 「大きな分析が要らない通」がどれだけあるかを数える（読み取りのみ・お客様名や本文は出さない）
// 2026-09-24 竹内「文生成する際に大きな分析を行うかの判断ができれば。大きくなくミスが起きないのは DeepSeek に」
// 実行: npx tsx --env-file=.env.local scripts/peek-brain-gate-candidates.ts [--days=7]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "7");

async function readAll<T>(table: string, select: string, since: string, order = "created_at"): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).gte("created_at", since).order(order, { ascending: true }).range(from, from + 999);
    if (error) { console.log(`${table}: ${error.message}`); return out; }
    const chunk = (data ?? []) as T[];
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}

type Decision = { id: string; conversation_id: string; created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; source: string | null; decision_source?: string | null; scene_evidence?: unknown; conversation_status: string | null };

// 相槌・お礼・了解だけの発言（分析が要らない候補）。本文は出さず、形だけで判定
const ACK_RE = /^[\s!！。．、,.…〜~♪♡♥☺️😊🙏✨👍🙇‍♂️🙇‍♀️🙇]*((ありがとう|有難う|ありがと)(ございます|ございました|う)?|了解(です|しました|いたしました)?|承知(しました|いたしました|です)?|かしこまりました|わかりました|分かりました|はい|OK|ok|おっけー|オッケー|お願いします|よろしくお願いします|宜しくお願い(します|いたします)|大丈夫です|助かります|すみません|すいません|失礼します|お疲れ様です|おはようございます|こんにちは|こんばんは)[\s!！。．、,.…〜~♪♡♥☺️😊🙏✨👍🙇‍♂️🙇‍♀️🙇]*$/u;

async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  // 表の列を先に見る（列名の想定違いで落ちないように）
  const { data: sample } = await sb.from("brain_decision_logs").select("*").limit(1);
  const cols = sample && sample[0] ? Object.keys(sample[0] as object) : [];
  console.log("brain_decision_logs の列:", cols.join(", "));
  const sel = ["id", "conversation_id", "created_at", "suggested_action", "suggested_reply_mode", "source", "conversation_status", cols.includes("decision_source") ? "decision_source" : null, cols.includes("scene_evidence") ? "scene_evidence" : null, cols.includes("analysis_mode") ? "analysis_mode" : null].filter(Boolean).join(", ");
  const decisions = await readAll<Decision & { analysis_mode?: string | null }>("brain_decision_logs", sel, since);
  console.log(`\n=== ${days}日分の判断 ${decisions.length}件 ===`);
  if (!decisions.length) return;
  const modeDist = new Map<string, number>();
  for (const d of decisions) modeDist.set(d.analysis_mode ?? "(なし)", (modeDist.get(d.analysis_mode ?? "(なし)") ?? 0) + 1);
  console.log(`分析の種類（full＝会話全体／incremental＝今回の発言だけ／cached＝LLM なし）: ${[...modeDist.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}×${v}`).join(" ")}`);

  // 直前のお客様発言（決定の 10分前〜決定時刻 の最後の customer メッセージ）
  const { data: msample } = await sb.from("messages").select("*").limit(1);
  const mcols = msample && msample[0] ? Object.keys(msample[0] as object) : [];
  console.log("messages の列:", mcols.join(", "));
  const textCol = ["content", "text", "message", "body"].find((c) => mcols.includes(c)) ?? "content";
  const senderCol = ["sender", "role", "sender_type", "from_role"].find((c) => mcols.includes(c)) ?? "sender";
  const msgs = await readAll<Record<string, unknown>>("messages", `id, conversation_id, created_at, ${textCol}, ${senderCol}`, new Date(new Date(since).getTime() - 3600_000).toISOString());
  const senderVals = new Map<string, number>();
  for (const m of msgs) senderVals.set(String(m[senderCol]), (senderVals.get(String(m[senderCol])) ?? 0) + 1);
  console.log("送り手の値:", [...senderVals.entries()].map(([k, v]) => `${k}×${v}`).join(" "));
  const isCustomer = (v: unknown) => /customer|user|line|顧客/i.test(String(v));
  const byConv = new Map<string, Array<{ t: number; text: string }>>();
  for (const m of msgs) {
    if (!isCustomer(m[senderCol])) continue;
    const arr = byConv.get(String(m.conversation_id)) ?? [];
    arr.push({ t: new Date(String(m.created_at)).getTime(), text: String(m[textCol] ?? "") });
    byConv.set(String(m.conversation_id), arr);
  }

  let withMsg = 0, ack = 0, short = 0, noAix = 0, noAixReply = 0, noAixReplyNoScene = 0, noAixReplyAck = 0, twoChoice = 0, postApply = 0;
  const actionCount = new Map<string, number>();
  const modeCount = new Map<string, number>();
  const ackAndAix = new Map<string, number>();
  for (const d of decisions) {
    const t = new Date(d.created_at).getTime();
    const arr = byConv.get(d.conversation_id) ?? [];
    const prev = arr.filter((m) => m.t <= t && m.t >= t - 10 * 60_000).pop();
    const text = prev?.text ?? null;
    if (text !== null) withMsg++;
    const isAck = text !== null && ACK_RE.test(text.trim());
    const isShort = text !== null && text.trim().length <= 12;
    if (isAck) ack++;
    if (isShort) short++;
    const a = d.suggested_action ?? "(なし)";
    actionCount.set(a, (actionCount.get(a) ?? 0) + 1);
    const m = d.suggested_reply_mode ?? "(なし)";
    modeCount.set(m, (modeCount.get(m) ?? 0) + 1);
    const hasAix = !!d.suggested_action && d.suggested_action !== "none";
    if (!hasAix) noAix++;
    if (m === "two_choice" || m === "aix") twoChoice++;
    if (/appl|closed|contract/i.test(d.conversation_status ?? "")) postApply++;
    const hasScene = !!(d.decision_source || d.scene_evidence);
    if (!hasAix && (m === "reply" || m === "(なし)")) {
      noAixReply++;
      if (!hasScene) noAixReplyNoScene++;
      if (isAck) noAixReplyAck++;
    }
    if (isAck && hasAix) ackAndAix.set(a, (ackAndAix.get(a) ?? 0) + 1);
  }
  console.log(`直前10分にお客様発言があった判断: ${withMsg}（残りはスタッフ送信・cron 起点）`);
  console.log(`\nAIX の内訳: ${[...actionCount.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}×${v}`).join(" ")}`);
  console.log(`返信モードの内訳: ${[...modeCount.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}×${v}`).join(" ")}`);
  console.log(`\n【軽い通の候補】`);
  console.log(`相槌・お礼・了解だけの発言: ${ack}（${(ack / decisions.length * 100).toFixed(0)}%）・12文字以下: ${short}`);
  console.log(`AIX なし: ${noAix}（${(noAix / decisions.length * 100).toFixed(0)}%）／ AIX なし＋返信だけ: ${noAixReply}（${(noAixReply / decisions.length * 100).toFixed(0)}%）／ さらに場面の証拠もなし: ${noAixReplyNoScene}（${(noAixReplyNoScene / decisions.length * 100).toFixed(0)}%）`);
  console.log(`相槌だけ＋AIX なし＋返信だけ: ${noAixReplyAck}（${(noAixReplyAck / decisions.length * 100).toFixed(0)}%）`);
  console.log(`2択／AIX モード: ${twoChoice}・申込以降: ${postApply}`);
  // 判断の出どころ（llm＝モデルが決めた／それ以外＝規則の層が決めた）と、AIX なしの通に場面の証拠があったか
  const srcDist = new Map<string, number>();
  let noAixWithScene = 0, noAixNoScene = 0;
  for (const d of decisions) {
    const hasAix = !!d.suggested_action && d.suggested_action !== "none";
    srcDist.set(hasAix ? (d.decision_source ?? "(なし)") : "AIXなし", (srcDist.get(hasAix ? (d.decision_source ?? "(なし)") : "AIXなし") ?? 0) + 1);
    if (!hasAix) { if (d.scene_evidence) noAixWithScene++; else noAixNoScene++; }
  }
  console.log(`\n判断の出どころ: ${[...srcDist.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}×${v}`).join(" ")}`);
  console.log(`AIX なし ${noAix} のうち 場面の証拠あり ${noAixWithScene}／なし ${noAixNoScene}（＝規則の層が何も拾わず AIX も要らなかった通・DeepSeek 候補の上限）`);
  if (ackAndAix.size) console.log(`⚠ 相槌だけの発言なのに AIX が付いた: ${[...ackAndAix.entries()].map(([k, v]) => `${k}×${v}`).join(" ")}（規則で飛ばすとこれを失う）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
