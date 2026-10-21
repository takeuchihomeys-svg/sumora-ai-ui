// scripts/audit-link-promise-picker.ts — つなぎ①（約束→ピッカー）・⑤（新着とピックアップ）の切れを1件ずつ読む（読むだけ・LLM なし・書かない）
//   ・①の切れ: 約束の種類・対象・結んだピッカー・約束の文
//   ・手打ちで果たした約束: 手打ちの中身を決まった語で分ける（見積書の金額・審査の結果・空き・設備…）→ ピッカーがあればそのピッカー・無ければ新しいピッカーの候補
//   ・⑤: 新着の約束の文と、果たした AIX
// 実行: npx tsx --env-file=.env.local scripts/audit-link-promise-picker.ts [--days=14] [--cache=<path.json>]
//   --cache: 材料を JSON に置いて2回目から DB を読まない（個人情報を含む＝リポジトリの外の一時フォルダに置く）
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadLinkWatchInputs } from "../app/lib/link-brain-watch-server";
import { classifyHandFulfillment, watchLinks, type LinkConvInput } from "../app/lib/link-brain-watch";
import { buildPromiseQueue, PROMISE_QUEUE_MAX_AGE_MS } from "../app/lib/promise-queue";
import { maskPII } from "../app/lib/pii-mask";

const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=14").slice(7));
const CACHE = process.argv.find((a) => a.startsWith("--cache="))?.slice(8);
(async () => {
  const nowMs = Date.now();
  const w = { fromMs: nowMs - DAYS * 86_400_000, toMs: nowMs, nowMs };
  let inputs: LinkConvInput[];
  if (CACHE && existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, "utf8")) as { w: typeof w; inputs: LinkConvInput[] };
    Object.assign(w, c.w); inputs = c.inputs;
  } else {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
    inputs = await loadLinkWatchInputs(sb, w);
    if (CACHE) writeFileSync(CACHE, JSON.stringify({ w, inputs }));
  }
  const mask = (s: string, i: LinkConvInput) => maskPII(s, [i.conv.customer_name]).replace(/\s+/g, " ");
  const byTopic = new Map<string, { picker: string | null; n: number; ex: string[] }>();
  const pickerOf = (c: { action: string | null; checkPattern: string | null }) => (c.action ? `${c.action}${c.checkPattern ? `/${c.checkPattern}` : ""}` : null);
  const brokenLines: string[] = [];
  for (const i of inputs) {
    const msgs = i.messages.map((x) => ({ sender: x.sender, text: x.text, createdAt: x.created_at, isAix: !!x.is_aix_generated }));
    const logs = i.aixLogs.map((x) => ({ aixType: x.aix_type, checkPattern: x.check_pattern, sentAt: x.sent_at ?? x.created_at, estimateSent: x.estimate_sent, text: x.generated_text }));
    const steps = buildPromiseQueue(msgs, logs, w.nowMs, { windowDays: Math.ceil((w.nowMs - w.fromMs) / 86_400_000) + 4 });
    for (const s of steps) {
      const at = Date.parse(s.promisedAt);
      const M = PROMISE_QUEUE_MAX_AGE_MS;
      if (!(at >= w.fromMs - M && at < w.toMs - M && at <= w.nowMs - M)) continue;
      if (s.kind === "pickup" && s.watch && s.status === "done") {
        const log = i.aixLogs.find((l) => (l.sent_at ?? l.created_at) === s.doneAt);
        brokenLines.push(`⑤ ${i.conv.id.slice(0, 8)} 新着の約束「${mask(s.evidence, i)}」→ ${log?.aix_type ?? s.doneBy}`);
        continue;
      }
      if (s.kind === "pickup" || s.watch || s.deferred) continue;
      const doneMs = Date.parse(s.doneAt ?? "");
      const late = s.status === "pending" || doneMs - at > M;
      const tag = s.status === "dropped" ? "やめた" : late ? (s.status === "pending" ? "未" : "遅れ") : s.doneBy === "返信" ? "手打ち" : s.doneBy;
      brokenLines.push(`① ${i.conv.id.slice(0, 8)} [${tag}] ${s.kind}:${s.object ?? "-"} ピッカー=${s.checkPattern ?? "-"}「${mask(s.evidence, i)}」`);
      if (s.doneBy === "返信" && !late) {
        const m = i.messages.find((x) => x.created_at === s.doneAt && x.sender !== "customer");
        const c = classifyHandFulfillment(m?.text ?? "");
        const cur = byTopic.get(c.topic) ?? { picker: pickerOf(c), n: 0, ex: [] };
        cur.n++;
        if (cur.ex.length < (c.topic === "その他" ? 10 : 3)) cur.ex.push(`${i.conv.id.slice(0, 8)} 約束=${s.kind}:${s.object ?? "-"} 手打ち「${mask(String(m?.text ?? ""), i).slice(0, 70)}」`);
        byTopic.set(c.topic, cur);
      }
    }
  }
  console.log(brokenLines.join("\n"));
  const sum = watchLinks(inputs, w);
  for (const id of ["promise_picker", "pickup_vs_watch"] as const) console.log(`\n■ ${id}: 見た ${sum.links[id].checked}・切れ ${sum.links[id].broken} ${JSON.stringify(sum.links[id].byType)}`);
  console.log("\n■ 手打ちで果たした約束の中身（決まった語で分けた）");
  for (const [t, v] of [...byTopic.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${t}: ${v.n}（AIX: ${v.picker ?? "無し＝新しいピッカーの候補"}）`);
    for (const e of v.ex) console.log(`     例 ${e}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
