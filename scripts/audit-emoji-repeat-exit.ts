// 出口 dedupeRepeatedEmoji（app/lib/emoji-repeat.ts）の全件監査（読み取りのみ・LLM なし）
// 2026-10-01 竹内「同じ絵文字を2重で使っているが実際していない」。手順7「過去の実送信・下書きに当てて変換の前後を目で読む」
//   ① テンプレ原文（templates）: 変わる物があれば、テンプレをそのまま送る形を出口が崩す（＝出口をかける前に原文を見る）
//   ② スタッフの実送信（messages・AIX でない）: 変わる通＝スタッフが同じ絵文字を残して送った形。どう変わるかを読む
//   ③ AI の下書き（ai_reply_examples.ai_draft）: 変わった下書きと、スタッフが実際に送った文を並べる（スタッフの直しに近づくか）
// 実行: npx tsx --env-file=.env.local scripts/audit-emoji-repeat-exit.ts   （DAYS=180・SHOW=12）
import { createClient } from "@supabase/supabase-js";
import { dedupeRepeatedEmoji } from "../app/lib/emoji-repeat";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const SHOW = Number(process.env.SHOW ?? 12);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
const one = (s: string) => s.replace(/\s+/g, " ").slice(0, 170);
const EM = /\p{Extended_Pictographic}/gu;
/** 文末の飾りの絵文字の並び（比べる用） */
const tailSeq = (s: string) => [...s.matchAll(/(\p{Extended_Pictographic}(?:️)?)(?=[！!。])/gu)].map((m) => m[1].replace(/️/g, "")).join("");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
async function pageAll(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  // ① テンプレ原文
  const { data: tpls, error } = await sb.from("templates").select("id, label, category, text");
  if (error) throw new Error(error.message);
  let tc = 0;
  console.log(`■ ① テンプレ原文 ${tpls?.length ?? 0}件`);
  for (const t of tpls ?? []) {
    const r = dedupeRepeatedEmoji(String(t.text ?? ""));
    if (!r.changes.length) continue;
    tc++;
    console.log(`  [${t.category}] ${t.label}: ${r.changes.map((c) => `${c.from}→${c.to || "なし"}「${c.sentence}」`).join(" / ")}`);
  }
  console.log(`  変わるテンプレ ${tc}件`);

  // ② スタッフの実送信
  const msgs = await pageAll((f, t) => sb.from("messages").select("id, text, created_at")
    .eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", since).neq("conversation_id", YUMA)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).range(f, t));
  let sc = 0, wordsChanged = 0;
  const ex: string[] = [];
  for (const m of msgs) {
    const s = String(m.text ?? "");
    const r = dedupeRepeatedEmoji(s);
    if (!r.changes.length) continue;
    sc++;
    if (s.replace(EM, "").replace(/️|‍/g, "") !== r.text.replace(EM, "").replace(/️|‍/g, "")) wordsChanged++;
    if (ex.length < SHOW) ex.push(`  前: ${one(s)}\n  後: ${one(r.text)}`);
  }
  console.log(`\n■ ② スタッフの実送信 ${msgs.length}通 → 変わる ${sc}通（言葉が変わった ${wordsChanged}）`);
  for (const e of ex) console.log(e + "\n");

  // ③ AI の下書き × 送った文
  const rows = await pageAll((f, t) => sb.from("ai_reply_examples").select("id, ai_draft, sent_reply, created_at")
    .gte("created_at", since).not("ai_draft", "is", null).not("sent_reply", "is", null)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).range(f, t));
  let dc = 0, closer = 0, same = 0, farther = 0;
  const ex3: string[] = [];
  for (const r of rows) {
    const d = String(r.ai_draft);
    const fx = dedupeRepeatedEmoji(d);
    if (!fx.changes.length) continue;
    dc++;
    const sent = tailSeq(String(r.sent_reply)), before = tailSeq(d), after = tailSeq(fx.text);
    if (after === sent && before !== sent) closer++; else if (before === sent) farther++; else same++;
    if (ex3.length < SHOW) ex3.push(`  下書き[${before}]→出口[${after}]／送った[${sent}]\n    出口: ${one(fx.text)}\n    送った: ${one(String(r.sent_reply))}`);
  }
  console.log(`\n■ ③ AI の下書き ${rows.length}組 → 出口で変わる ${dc}組: 送った文の文末の絵文字と一致するようになった ${closer}／元の下書きの方が送った文と同じ ${farther}／どちらでもない ${same}`);
  for (const e of ex3) console.log(e + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
