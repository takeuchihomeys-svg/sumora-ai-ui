// scripts/audit-customer-memo-shadow.ts — お客様のメモの「影」の1週間（DeepSeek の読み取りは保存だけ・ブレインと返信には渡さない）の中身を目で確かめる（読むだけ・LLM なし）
//   10/08 竹内さん「メモの読み取りは影で1週間」。CUSTOMER_MEMO_LLM_NOTE=on にする前に、この出力を読む。
//   ①会話ごとに今効いている行（種類・中身・根拠の言葉・時刻・確かさ）②根拠の言葉が本当にその会話の通にあるか（無い＝作り事の疑い）
//   ③スタッフが「違う」で外した行・直した行（＝読み取りの外れ）④種類ごとの数・読み取りの回数と費用（llm_usage_logs action=customer_memo）
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-memo-shadow.ts [--days=7] [--conv=<id の頭>] [--n=40]
import { createClient } from "@supabase/supabase-js";
import { MEMO_KIND_JA, liveItems, type StoredMemo, type MemoItem } from "../app/lib/customer-memo";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "7")); const CONV = arg("conv", ""); const N = Number(arg("n", "40"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const norm = (s: string) => s.normalize("NFKC").replace(/[\s、。・！!？?「」]/g, "");
const jst = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "-");

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  let q = sb.from("customer_memos").select("conversation_id, items, hidden_rule_ids, llm_watermark, llm_at, updated_at").gte("updated_at", since).order("updated_at", { ascending: false }).limit(500);
  if (CONV) q = q.like("conversation_id", `${CONV}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ conversation_id: string; items: MemoItem[]; hidden_rule_ids: string[]; llm_at: string | null }>;
  const kindCount = new Map<string, number>(); let live = 0, ungrounded = 0, staffRetired = 0, staffEdited = 0, staffAdded = 0, shown = 0;
  for (const r of rows) {
    const memo: StoredMemo = { items: r.items ?? [], hiddenRuleIds: r.hidden_rule_ids ?? [], llmWatermark: null };
    const items = liveItems(memo, Date.now());
    const { data: msgs } = await sb.from("messages").select("text, created_at").eq("conversation_id", r.conversation_id).gte("created_at", new Date(Date.now() - 70 * 864e5).toISOString()).limit(600);
    const corpus = norm(((msgs ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n"));
    const lines: string[] = [];
    for (const x of items) {
      live++; kindCount.set(x.kind, (kindCount.get(x.kind) ?? 0) + 1);
      const ok = !x.sourceQuote || corpus.includes(norm(x.sourceQuote).slice(0, 20));
      if (x.origin === "llm" && !ok) ungrounded++;
      if (x.origin === "staff") staffAdded++;
      lines.push(`   ${x.origin === "staff" ? "✍" : ok ? " " : "⚠"} ${MEMO_KIND_JA[x.kind]}: ${x.text}${x.property ? `（${x.property}）` : ""}${x.certainty === "maybe" ? "（たぶん）" : ""} ＝${jst(x.sourceAt)}「${x.sourceQuote ?? ""}」${ok ? "" : " ←根拠の言葉が会話に無い"}`);
    }
    for (const x of r.items ?? []) if (x.retiredAt && /スタッフ/.test(x.retiredReason ?? "")) { staffRetired++; lines.push(`   ✗ スタッフが外した: ${MEMO_KIND_JA[x.kind]}: ${x.text}`); }
    for (const x of r.items ?? []) if (x.locked && x.origin === "staff" && x.id.startsWith("l-")) staffEdited++;
    if (shown < N && lines.length) { shown++; console.log(`\n## ${r.conversation_id.slice(0, 8)}（読んだ ${jst(r.llm_at)}・外した決まった計算 ${r.hidden_rule_ids?.length ?? 0}）`); for (const l of lines) console.log(l); }
  }
  const { data: use } = await sb.from("llm_usage_logs").select("input_uncached, cache_read, output_tokens, error_type").eq("action", "customer_memo").gte("created_at", since);
  const u = (use ?? []) as Array<{ input_uncached: number; cache_read: number; output_tokens: number; error_type: string | null }>;
  const cost = u.reduce((a, r) => a + (r.input_uncached * 0.15 + r.cache_read * 0.003 + r.output_tokens * 0.6) / 1e6, 0);
  console.log(`\n== ${DAYS}日: 会話 ${rows.length}・効いている行 ${live}（${[...kindCount].map(([k, v]) => `${MEMO_KIND_JA[k as keyof typeof MEMO_KIND_JA] ?? k} ${v}`).join("・")}）`);
  console.log(`   根拠の言葉が会話に無い DeepSeek の行 ${ungrounded}・スタッフが足した ${staffAdded}・直した ${staffEdited}・外した ${staffRetired}`);
  console.log(`   読み取り ${u.length}回（崩れ ${u.filter((r) => r.error_type).length}）・約 $${cost.toFixed(4)}（flash の単価・ピーク倍は入れていない）`);
})().catch((e) => { console.error(e); process.exit(1); });
