// scripts/conductor-replan-count.ts — #8 E の数え（作業員5・11/05・読むだけ・LLM なし・夜だけ）
//   竹内さんの番（staff_writer=takeuchi・sure）で、お客様の連投が1分以上あとに続いた番を集め、後から来た通を conductor-replan.replanCandidate に当てる。
//   ①keep にした番の後の通を目で読む（誤り＝依頼・質問が入っているのに keep）②KB 2d0f33cf の型（こちらのピックアップの約束の直後のお礼・スタンプ）で、
//   竹内さんの一手が AIX か（keep で前の AIX が残る形か）を数える。材料は伏せて exam-cache だけに置く。
// 実行: npx tsx --env-file=.env.local scripts/conductor-replan-count.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestConversation } from "../app/lib/test-conversations";
import { maskPII } from "../app/lib/pii-mask";
import { replanCandidate } from "../app/lib/conductor-replan";
import { maskContactBits } from "../app/lib/conductor-turn-vectors";

const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22) { console.log(`営業時間（JST ${jstHour}時）は回さない`); process.exit(0); }
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "90");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null; staff_writer_confidence: string | null };
const COLS = "id, conversation_id, sender, text, created_at, is_aix_generated, staff_writer, staff_writer_confidence";
const PICKUP_PROMISE = /(ピックアップ|お探し|探させ).{0,30}(お送り|ご連絡).{0,10}(させて頂きます|致します|いたします)/;

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const convIds = new Set<string>();
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").eq("staff_writer_confidence", "sure").gte("created_at", since).range(i, i + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ conversation_id: string }>) if (!isTestConversation(r.conversation_id)) convIds.add(r.conversation_id);
    if ((data ?? []).length < 1000) break;
  }
  const ids = [...convIds];
  let turns = 0, burst = 0, keep = 0, reread = 0;
  const keepRows: Array<{ later: string[]; aix: boolean }> = [];
  const pk = { n: 0, aix: 0, reply: 0 };
  for (let c = 0; c < ids.length; c += 20) {
    const msgs: Msg[] = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await sb.from("messages").select(COLS).in("conversation_id", ids.slice(c, c + 20)).gte("created_at", since).order("created_at", { ascending: true }).range(i, i + 999);
      if (error) throw new Error(error.message);
      msgs.push(...((data ?? []) as Msg[])); if ((data ?? []).length < 1000) break;
    }
    const by = new Map<string, Msg[]>();
    for (const m of msgs) { const l = by.get(m.conversation_id) ?? []; l.push(m); by.set(m.conversation_id, l); }
    for (const all of by.values()) {
      for (let k = 1; k < all.length; k++) {
        const s = all[k];
        if (s.sender === "customer" || all[k - 1].sender !== "customer" || s.staff_writer !== "takeuchi" || s.staff_writer_confidence !== "sure") continue;
        let j = k - 1; while (j >= 0 && all[j].sender === "customer") j--;
        const cust = all.slice(j + 1, k);
        turns++;
        const prevStaff = j >= 0 ? all[j] : null;
        // KB 2d0f33cf の型: 直前のこちらの送信がピックアップの約束・お客様はお礼・スタンプだけ
        const ackOnly = replanCandidate({ newTexts: cust.map((m) => m.text) }).kind === "keep";
        if (prevStaff && !prevStaff.is_aix_generated && PICKUP_PROMISE.test(prevStaff.text ?? "") && ackOnly) { pk.n++; if (s.is_aix_generated) pk.aix++; else pk.reply++; }
        // 途中の新しい通: 最初の通から1分以上あとに来た通
        const t0 = Date.parse(cust[0].created_at);
        const later = cust.filter((m) => Date.parse(m.created_at) - t0 >= 60_000);
        if (!later.length) continue;
        burst++;
        const r = replanCandidate({ newTexts: later.map((m) => m.text) });
        if (r.kind === "keep") { keep++; keepRows.push({ later: later.map((m) => maskContactBits(maskPII(m.text ?? "")).slice(0, 60)), aix: !!s.is_aix_generated }); } else reread++;
      }
    }
  }
  const out = join(process.cwd(), "..", "..", "exam-cache", "conductor-replan");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `count-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify({ turns, burst, keep, reread, pk, keepRows }, null, 1));
  console.log(`竹内さんの番 ${turns}・途中の新しい通がある番 ${burst}（keep ${keep}・reread ${reread}）`);
  console.log(`KB 2d0f33cf の型（ピックアップの約束の直後のお礼・スタンプ）: ${pk.n}番・竹内さんは AIX ${pk.aix}・返信 ${pk.reply}`);
  const cnt = new Map<string, number>(); for (const r of keepRows) { const k = r.later.join(" / "); cnt.set(k, (cnt.get(k) ?? 0) + 1); }
  console.log("keep にした後の通（多い順・伏せ済み）:"); for (const [k, v] of [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${v}× ${k}`);
})().catch((e) => { console.error(e); process.exit(1); });
