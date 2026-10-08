// scripts/audit-request-ledger.ts — 連投の「やる事の一覧」（app/lib/request-ledger.ts）を本番の会話で目で読む・数える（読むだけ・LLM なし）
//   ①一覧の数（束あたりの項目数・種類）②人の応答（48時間・次のお客様の発言まで）の後に残る未対応＝人が落とした or 物差しの取りこぼし
//   ③出口の確かめ（uncoveredRequests）を人の最初の手打ちに当てた時に「抜け」と出る数＝警告にした時の誤検知の目安
// 実行: npx tsx --env-file=.env.local scripts/audit-request-ledger.ts [--days=60] [--show=open|exit|items] [--n=40]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { splitRequests, buildRequestLedger, uncoveredRequests, TOPIC_JA, type LedgerMsg } from "../app/lib/request-ledger";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60")); const SHOW = arg("show", "open"); const N = Number(arg("n", "40"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: M[] = [];
  for (let i = 0; i < 400_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message); msgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, LedgerMsg[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }); }
  let bundles = 0, multi = 0, items = 0, openAfter = 0, promisedAfter = 0, exitChecked = 0, exitFlag = 0;
  const topicN: Record<string, number> = {};
  const exOpen: string[] = [], exExit: string[] = [], exItems: string[] = [];
  for (const [cid, list] of by) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
      let j = i; while (j < list.length && list[j].sender === "customer") j++;
      const bundle = list.slice(i, j).map((m) => String(m.text ?? ""));
      const its = splitRequests(bundle, list[i].createdAt);
      bundles++;
      if (!its.length) continue;
      items += its.length; if (its.length >= 2) multi++;
      for (const x of its) topicN[x.topic] = (topicN[x.topic] ?? 0) + 1;
      if (its.length >= 2 && exItems.length < N) exItems.push(`${cid.slice(0, 6)} ${list[i].createdAt.slice(5, 16)} ${its.map((x) => `[${TOPIC_JA[x.topic]}]${x.quote.slice(0, 30)}`).join(" ｜ ")}`);
      // 人の応答（次のお客様の束まで・48時間）
      const T = Date.parse(list[i].createdAt);
      let k = j; while (k < list.length && list[k].sender !== "customer" && Date.parse(list[k].createdAt) - T <= 48 * 3600_000) k++;
      const resp = list.slice(j, k);
      if (!resp.length) continue;
      const led = buildRequestLedger([...list.slice(i, j), ...resp], T + 49 * 3600_000, { windowDays: 3 });
      for (const x of led) {
        if (x.status === "open" && x.topic !== "other") { openAfter++; if (exOpen.length < N) exOpen.push(`${cid.slice(0, 6)} ${list[i].createdAt.slice(5, 16)} [${TOPIC_JA[x.topic]}]「${x.quote.slice(0, 40)}」→ 人:${resp.map((r) => (r.isAix ? "[AIX]" : "") + String(r.text ?? "").replace(/\s+/g, " ").slice(0, 70)).join(" / ").slice(0, 200)}`); }
        if (x.status === "promised") promisedAfter++;
      }
      // 出口の確かめ: 人の最初の手打ち（AIX でない・2件以上の束）
      const firstHand = resp.find((r) => !r.isAix && String(r.text ?? "").trim().length > 5);
      if (its.length >= 2 && firstHand) {
        exitChecked++;
        const un = uncoveredRequests(its, String(firstHand.text ?? ""));
        if (un.length) { exitFlag++; if (exExit.length < N) exExit.push(`${cid.slice(0, 6)} ${list[i].createdAt.slice(5, 16)} 抜け=${un.map((x) => TOPIC_JA[x.topic]).join("・")}｜客:${bundle.join(" / ").replace(/\s+/g, " ").slice(-120)}｜人:${String(firstHand.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`); }
      }
    }
  }
  console.log(`束 ${bundles}・項目のある束 ${bundles ? "" : ""}・項目 ${items}・2件以上の束 ${multi}`);
  console.log(`種類: ${Object.entries(topicN).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${TOPIC_JA[k as keyof typeof TOPIC_JA]} ${v}`).join("・")}`);
  console.log(`人の応答（48時間）の後: 未対応 ${openAfter}（その他を除く）・約束済み ${promisedAfter}`);
  console.log(`出口の確かめ（2件以上の束 × 人の最初の手打ち）: ${exitChecked} 中「抜け」と出る ${exitFlag}`);
  const ex = SHOW === "exit" ? exExit : SHOW === "items" ? exItems : exOpen;
  console.log(`\n== ${SHOW}`); for (const e of ex) console.log("  " + e);
}
main().catch((e) => { console.error(e); process.exit(1); });
