// scripts/audit-customer-karte.ts — 台帳 #806 お客様のカルテの物差し（本番の会話を読むだけ・LLM なし・22時以降）
// 2026-11-27 夜 作業員L（統括役の頼み・夜の分析）: CUSTOMER_KARTE=on にした時に、どれだけの会話でカルテが出るか・欄ごとの埋まり・字数・審査の事情で落とした欄の数を、
//   今の本番の会話に karteOf を当てて数える（プロンプトにも DB にも書かない。--write の時だけ quality_daily に karte:* を書く）。申込以降・テスト会話は外す。
//   報告には数だけ（お客様の名前・本文は出さない）
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-karte.ts [--days=7] [--max-conv=150] [--write]
import { requireFreeMemMb } from "./lib/free-mem-guard";
import { createClient } from "@supabase/supabase-js";
import { karteOf, karteBlock, type Karte, type KarteMsg, type KartePc, type KarteSent } from "../app/lib/customer-karte";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => process.argv.includes(`--${k}`);
const FIELDS: Array<keyof Omit<Karte, "dropped">> = ["priorities", "noGo", "decider", "replySpeed", "wording", "cost", "declined"];

async function main() {
  // 2026-11-28 作業員L（統括役の決め）: 流す前の空きメモリの関所（1000MB・--min-free= で変える・--wait-min= の間待つ）
  await requireFreeMemMb(Number(process.argv.find((a) => a.startsWith("--min-free="))?.slice(11) ?? "") || 1000, { waitMin: Number(process.argv.find((a) => a.startsWith("--wait-min="))?.slice(11) ?? "0") || 0, label: "#806 カルテ" });
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const days = Number(arg("days", "7")) || 7, maxConv = Number(arg("max-conv", "150")) || 150;
  const since = new Date(Date.now() - days * 86_400_000).toISOString(); const nowIso = new Date().toISOString();
  const { data: recent, error } = await sb.from("messages").select("conversation_id, created_at").eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: false }).limit(5000);
  if (error) throw new Error(error.message);
  const test = new Set<string>(TEST_CONVERSATION_IDS as readonly string[]);
  const convs = [...new Set(((recent ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !test.has(c)).slice(0, maxConv);
  const { data: cs } = await sb.from("conversations").select("id, status, property_customer_id").in("id", convs);
  const convRows = new Map(((cs ?? []) as Array<{ id: string; status: string | null; property_customer_id: string | null }>).map((r) => [r.id, r]));
  const statusOf = new Map([...convRows].map(([id, r]) => [id, r.status]));
  let n = 0, post = 0, withBlock = 0, lenSum = 0; const filled: Record<string, number> = {}; let droppedN = 0;
  for (const conv of convs) {
    if (isPostApplyStatus(statusOf.get(conv) ?? null)) { post++; continue; }
    // 2026-11-28: 条件の行は conversations.property_customer_id で引く（brain-core と同じ）・送った物件は property_customer_id か conversation_id（読みの失敗は止める＝黙って空にしない）
    const pcid = convRows.get(conv)?.property_customer_id ?? null;
    const [{ data: pc, error: e1 }, { data: msgs, error: e2 }, { data: sent, error: e3 }] = await Promise.all([
      pcid ? sb.from("property_customers").select("preferences, ng_points, desired_area, floor_plan, rent_max, initial_cost_limit").eq("id", pcid).maybeSingle() : Promise.resolve({ data: null, error: null }),
      sb.from("messages").select("sender, text, created_at").eq("conversation_id", conv).order("created_at", { ascending: false }).limit(60),
      sb.from("sent_properties").select("property_name, room_no, sent_at, rent").or(pcid ? `property_customer_id.eq.${pcid},conversation_id.eq.${conv}` : `conversation_id.eq.${conv}`).order("sent_at", { ascending: false }).limit(30),
    ]);
    const err = e1 ?? e2 ?? e3; if (err) throw new Error(`読めない: ${err.message}`);
    const k = karteOf({ pc: (pc ?? null) as KartePc, msgs: ((msgs ?? []) as KarteMsg[]), sent: (sent ?? []) as KarteSent[], nowIso, names: [] });
    n++; const b = karteBlock(k); if (b) { withBlock++; lenSum += b.length; }
    for (const f of FIELDS) if (k[f]) filled[f] = (filled[f] ?? 0) + 1;
    droppedN += k.dropped.length;
  }
  const pct = (x: number) => (n ? Math.round((x / n) * 1000) / 10 : 0);
  console.log(`お客様のカルテ（#806・前の${days}日・会話 ${convs.length}・申込以降で外した ${post}・数えた ${n}）`);
  console.log(`- カルテが出る: ${withBlock}/${n}（${pct(withBlock)}%）・平均 ${withBlock ? Math.round(lenSum / withBlock) : 0}字・審査の事情で落とした欄 ${droppedN}`);
  console.log(`- 欄ごとの埋まり: ${FIELDS.map((f) => `${f} ${pct(filled[f] ?? 0)}%`).join("・")}`);
  if (flag("write")) {
    const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const rows = [{ metric: "karte:has_block", value: pct(withBlock) }, { metric: "karte:avg_len", value: withBlock ? Math.round(lenSum / withBlock) : 0 }, { metric: "karte:dropped", value: droppedN }, ...FIELDS.map((f) => ({ metric: `karte:field:${f}`, value: pct(filled[f] ?? 0) }))]
      .map((r) => ({ day, scope: "all", ...r, n, detail: { post, days }, source: "scripts/audit-customer-karte.ts（作業員L・#806）" }));
    const { error: we } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
    console.log(we ? `書けない: ${we.message}` : `quality_daily に ${rows.length}行`);
  }
}
if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
