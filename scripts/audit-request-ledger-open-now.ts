// scripts/audit-request-ledger-open-now.ts — 会話画面の帯「お客様の確認事項」に今残っている項目（未対応・約束済み）を、その後のこちらの送信と並べて目で読む（読むだけ・LLM なし）
//   2026-10-13 竹内さん（ゆなまる）「ここの部分答えているのに、なぜか残り続けている。こちらから送った事は認識していないのか？」
//   取りこぼし（本当は答え済み）＝0、誤って済み（本当は未対応）＝0 の線を探すための監査。--done も付けると「済み」にした根拠の送信も出す
// 実行: npx tsx --env-file=.env.local scripts/audit-request-ledger-open-now.ts [--days=30] [--done] [--status=open|promised|all]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { buildRequestLedger, TOPIC_JA, type LedgerMsg } from "../app/lib/request-ledger";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30")); const SHOW_DONE = process.argv.includes("--done"); const ST = arg("status", "all");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
const one = (s: string | null | undefined, n: number) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: M[] = [];
  for (let i = 0; i < 400_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message); msgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, LedgerMsg[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }); }
  const now = Date.now();
  let total = 0, open = 0, promised = 0, done = 0, noReply = 0;
  for (const [cid, list] of by) {
    const led = buildRequestLedger(list, now, { windowDays: DAYS });
    for (const x of led) {
      total++;
      if (x.status === "done") done++; else if (x.status === "open") open++; else promised++;
      const after = list.filter((m) => m.sender !== "customer" && Date.parse(m.createdAt) > Date.parse(x.saidAt) && !/^\[(?:画像|動画|スタンプ|ファイル)\]$/.test(String(m.text ?? "").trim()));
      if (x.status === "done") {
        if (!SHOW_DONE) continue;
        const by = after.find((m) => m.createdAt === x.doneAt);
        console.log(`DONE ${cid.slice(0, 8)} ${x.saidAt.slice(5, 16)} [${TOPIC_JA[x.topic]}]「${one(x.quote, 50)}」← ${x.doneBy}: ${one(by?.text, 140)}`);
        continue;
      }
      if (ST !== "all" && ST !== x.status) continue;
      if (!after.length) { noReply++; continue; }
      console.log(`\n${x.status.toUpperCase()} ${cid.slice(0, 8)} ${x.saidAt.slice(5, 16)} [${TOPIC_JA[x.topic]}]「${x.quote}」${x.deferred ? "（先の時期）" : ""}`);
      for (const m of after.slice(0, 3)) console.log(`   ${m.createdAt.slice(5, 16)} ${m.isAix ? "AIX" : "手"}: ${one(m.text, 160)}`);
    }
  }
  console.log(`\n項目 ${total}・済み ${done}・未対応 ${open}・約束済み ${promised}（うちこちらの送信がまだ無い ${noReply}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
