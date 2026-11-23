// scripts/dig-guide-414.ts — 誘導の穴 #414（物件提案中 × 返信で約束 → 35番中23番が止まる）の掘り（読むだけ・LLM なし・費用0）
//
// 2026-11-19 作業員L（統括役の 11/19 昼の頼み 3）。読む物は audit-guide.ts と同じ（竹内さん本人の送信のある会話の messages・aix_usage_logs・
//   brain_decision_logs の digest.sg）に、sent_properties（送った時刻）と property_pickups（候補の時刻・期限・送った時刻）を足す。
//   1番ごとの分け（scripts/lib/promise-stuck-dig.ts）:
//     ③候補があったのに約束 … その時に送れる候補があった（物件を送る AIX の番だったかもしれない）
//     ④約束待ちのお礼で窓が閉じた … 物差しの作りの都合（約束を果たす前の「ありがとうございます」で測っている）→ 測り直しの結果を見る
//     約束を果たさず止まった … 72時間の中で物件・確認の結果・見積の AIX も物件の送付も無い（約束の取りこぼし）
//     果たした後も止まった … 果たした後の返事でも駅が進まない（物件が刺さらない・次の誘いが無い）→ 次の竹内さんの一手を見る
//   会話の文は出さない（会話の id の頭6字・時刻・型だけ）。--show-staff の時だけ竹内さんの約束の文の頭60字を出す（お客様の文は出さない）。
//   重い読み: audit-guide と同じ。営業時間（JST 9〜22時）は --days=2 --max-conv=20 に絞る（全部は22時以降）。--force は手元の確かめだけ。
// 実行（22時以降）: npx tsx --env-file=.env.local scripts/dig-guide-414.ts [--days=60] [--max-conv=400] [--json=<出力>] [--show-staff]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import type { GMsg, GAix, GDecision } from "./lib/guide-measure";
import { decisionOfDigest } from "./lib/guide-measure";
import { promiseStuckRowsOf, digSummary, PROMISE_KIND_JA, type GSent, type GPick, type PromiseDigRow } from "./lib/promise-stuck-dig";
import { NO_LINE_TEST_CONVERSATION_IDS, STAFF_INTERNAL_CONVERSATION_IDS, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
(async () => {
  let days = Number(arg("days", "60")) || 60, maxConv = Number(arg("max-conv", "400")) || 400;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 2); maxConv = Math.min(maxConv, 20); console.log(`営業時間なので --days=${days} --max-conv=${maxConv} に絞った（全部は22時以降）`); }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const sinceWide = new Date(Date.now() - (days + 3) * 86_400_000).toISOString(); // 候補は3日前から
  const skip = new Set<string>([YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS, ...STAFF_INTERNAL_CONVERSATION_IDS]);
  const { data: tk, error } = await sb.from("messages").select("conversation_id").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).limit(20000);
  if (error) throw new Error(error.message);
  const convs = [...new Set(((tk ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !skip.has(c)).slice(0, maxConv);
  const rows: PromiseDigRow[] = [];
  const staffHead = new Map<string, string>();
  for (const c of convs) {
    const m = await sb.from("messages").select("sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(2000);
    const msgs = (m.data ?? []) as GMsg[];
    // 約束の文が1通も無い会話は残りを読まない（読みを減らす）
    if (!msgs.some((x) => x.sender === "staff" && x.staff_writer === "takeuchi" && /ピックアップ|お送りさせて頂きます|お調べ|確認(?:出来|でき)次第|確認させて頂きます/.test(String(x.text ?? "")))) continue;
    const [a, d, s, p] = await Promise.all([
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).limit(500),
      sb.from("brain_decision_logs").select("created_at, digest").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(1000),
      sb.from("sent_properties").select("sent_at").eq("conversation_id", c).gte("sent_at", since).limit(500),
      sb.from("property_pickups").select("created_at, expired_at, sent_at, status").eq("conversation_id", c).gte("created_at", sinceWide).limit(500),
    ]);
    const decisions: GDecision[] = ((d.data ?? []) as Array<{ created_at: string; digest: { sg?: string; cp?: string } | null }>).map((x) => decisionOfDigest(x.created_at, x.digest));
    const got = promiseStuckRowsOf(c, msgs, (a.data ?? []) as GAix[], decisions, (s.data ?? []) as GSent[], (p.data ?? []) as GPick[]);
    rows.push(...got);
    if (process.argv.includes("--show-staff")) for (const r of got) {
      const t = msgs.find((x) => x.created_at === r.at)?.text ?? "";
      staffHead.set(`${r.conv}|${r.at}`, Array.from(String(t).replace(/\s+/g, " ")).slice(0, 60).join(""));
    }
  }
  const sum = digSummary(rows);
  console.log(`#414 の掘り（${days}日・会話 ${convs.length}・物件提案中 × 返信で約束 ${rows.length}番）`);
  console.log(`分け: ${Object.entries(sum.byBucket).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・")}`);
  console.log(`約束の種類: ${Object.entries(sum.byKind).map(([k, n]) => `${PROMISE_KIND_JA[k as keyof typeof PROMISE_KIND_JA] ?? k} ${n}`).join("・")}`);
  console.log(`測り直し（果たした後の次の返事）: ${Object.entries(sum.remeasured).map(([k, n]) => `${k} ${n}`).join("・")}・果たすまでの中央 ${sum.medianFulfilH ?? "-"}時間`);
  console.log("\n## 1番ごと（会話の頭6字・時刻・約束・候補・果たした・前の返事・測り直し・次の一手・分け）");
  for (const r of rows.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.at.localeCompare(b.at))) {
    console.log(`${r.conv.slice(0, 6)} ${r.at.slice(0, 16)} ${r.kind.padEnd(11)} 候補${r.pendingAtPromise} 果たした ${r.fulfilHours != null ? `${r.fulfilHours}h ${r.fulfilBy}` : "なし"}・前の返事 ${r.replyBeforeFulfil}・後 ${r.afterFulfilReplyCat}/${r.afterFulfilReply ?? "?"}→${r.remeasured}・次 ${r.nextAct ?? "-"}・${r.bucket}`);
    const sh = staffHead.get(`${r.conv}|${r.at}`); if (sh) console.log(`   約束の文: ${sh}`);
  }
  console.log("\n読み方: ③ が多い→約束でなく物件を送る AIX の番（返信か AIX かの判断・統括へ）／④ が多い→物差しの測り直しを本番の数えに（guide-measure の窓を「果たした後の返事」に）／");
  console.log("        果たさず→約束の取りこぼし（promise-close・行動台帳）／果たした後も止まった→送った物件の合い方か次の誘い（作業員K・H）");
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify(rows.map((r) => ({ ...r, conv: r.conv.slice(0, 6) })), null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
