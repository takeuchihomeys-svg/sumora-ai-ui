// scripts/audit-pickup-select-link.ts — 土台「物件選定と LINE の連携（選んだ理由・刺さった点）」の毎日の数（読むだけ・LLM なし・費用0・軽い読み）
//
// 2026-11-22 作業員K2（台帳 #545・土台 k2.pickup_select の物差し）。
//   ① 選んだ理由: 直近 N 日に送った AIX【物件ピックアップした】のうち、送った前後1時間に売上サポの記録（property_pickups status=sent）があり、
//      判定の札（reason_codes）が1つ以上付いた物件がある番＝ブレイン（PICKUP_WHY_TO_BRAIN）に「なぜ選んだか」を渡せる番の割合。
//      無い番は、AIX ツールを通らずに送った（画像だけ・手で選んだ）か、札が付かなかった番（SIP_JUDGE が拾う側）。
//   ② 刺さった点: 同じ N 日に、お客様が物件の通を引用して返し、sent_properties.customer_hook_points が付いた物件の数と会話の数（SENT_HOOK_POINTS の届き）。
//   テストの会話は外す。会話は頭8字だけ。
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-select-link.ts [--days=7] [--show] [--json | --json=<道>]
//   --json: 1行の {days, n, why, rate, no_pickup_row, no_pickup_row_with_images, no_codes, hook_rows, hook_convs, convs:[頭8字・理由の無い番]}（毎朝の1枚の growth:pickup_select:理由あり 用）
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";
import { loadTurnApplicationRecords } from "../app/lib/turn-application-gate-server";
import { turnApplicationReason } from "../app/lib/turn-application-gate";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const isTest = (c: string) => isTestConversation(c) || isNoLineTestConversation(c);
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "7")) || 7;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: logs, error } = await sb.from("aix_usage_logs").select("conversation_id, sent_at").eq("aix_type", "property_send").gte("sent_at", since).order("sent_at").limit(2000);
  if (error) throw new Error(error.message);
  let n = 0, why = 0, noRow = 0, noRowSip = 0, noCodes = 0; const missing: string[] = [];
  // 2026-11-23 作業員A（#647 の確かめ）: 欠けの番の多くは申込以降の会話（画像は DeepSeek で読まない線・申込以降は対象外）。
  //   今の rate はそのまま（毎朝の1枚の値を変えない）で、申込の前の番だけの数（n_pre・why_pre・rate_pre）を並べて出す（turn-application-gate の門）
  let nPre = 0, whyPre = 0; const gateCache = new Map<string, Awaited<ReturnType<typeof loadTurnApplicationRecords>>>();
  for (const l of (logs ?? []) as Array<{ conversation_id: string | null; sent_at: string }>) {
    if (!l.conversation_id || isTest(l.conversation_id)) continue;
    n++;
    if (!gateCache.has(l.conversation_id)) gateCache.set(l.conversation_id, await loadTurnApplicationRecords(sb as never, l.conversation_id));
    const pre = !turnApplicationReason(gateCache.get(l.conversation_id)!, l.sent_at);
    if (pre) nPre++;
    const a = new Date(Date.parse(l.sent_at) - 36e5).toISOString(), b = new Date(Date.parse(l.sent_at) + 36e5).toISOString();
    const { data: pk } = await sb.from("property_pickups").select("reason_codes").eq("conversation_id", l.conversation_id).eq("status", "sent").gte("sent_at", a).lte("sent_at", b).limit(50);
    const rows = (pk ?? []) as Array<{ reason_codes: unknown }>;
    if (!rows.length) {
      noRow++; missing.push(l.conversation_id.slice(0, 8));
      // 売上サポを通らずに画像で送った番（sent_image_properties がある＝SIP_JUDGE が判定に通せる側）
      const { count } = await sb.from("sent_image_properties").select("conversation_id", { count: "exact", head: true }).eq("conversation_id", l.conversation_id).gte("created_at", new Date(Date.parse(l.sent_at) - 2 * 36e5).toISOString()).lte("created_at", b);
      if ((count ?? 0) > 0) noRowSip++;
      continue;
    }
    if (rows.some((r) => Array.isArray(r.reason_codes) && r.reason_codes.length > 0)) { why++; if (pre) whyPre++; }
    else { noCodes++; missing.push(l.conversation_id.slice(0, 8)); }
  }
  const { data: hooks } = await sb.from("sent_properties").select("conversation_id").not("customer_hook_points", "is", null).gte("created_at", new Date(Date.now() - (days + 30) * 864e5).toISOString()).limit(3000);
  // 刺さった点は送った日ではなく引用の返事の日に付く＝送ったのが前でも数える（送った物件の行は 30日 前まで見る）
  const hookRows = ((hooks ?? []) as Array<{ conversation_id: string | null }>).filter((h) => h.conversation_id && !isTest(h.conversation_id));
  const out = { days, n, why, rate: n ? Math.round((why / n) * 1000) / 10 : null, no_pickup_row: noRow, no_pickup_row_with_images: noRowSip, no_codes: noCodes, hook_rows: hookRows.length, hook_convs: new Set(hookRows.map((h) => h.conversation_id)).size, convs: [...new Set(missing)],
    n_pre: nPre, why_pre: whyPre, rate_pre: nPre ? Math.round((whyPre / nPre) * 1000) / 10 : null };
  const jsonArg = process.argv.find((x) => x === "--json" || x.startsWith("--json="));
  if (jsonArg === "--json") { console.log(JSON.stringify(out)); return; }
  if (jsonArg) writeFileSync(jsonArg.slice(7), JSON.stringify(out, null, 2));
  console.log(`物件ピックアップ（${days}日・テストを外す）: ${n}番・選んだ理由（札つきの売上サポの記録）あり ${why}（${out.rate ?? "-"}%）・記録なし ${noRow}（うち画像の読みあり ${noRowSip}）・札なし ${noCodes}／刺さった点の付いた送った物件 ${out.hook_rows}（${out.hook_convs}会話）`);
  console.log(`  申込の前の番だけ（申込以降は対象外）: ${nPre}番・理由あり ${whyPre}（${out.rate_pre ?? "-"}%）`);
  if (process.argv.includes("--show") && out.convs.length) console.log("  理由の無い番:", out.convs.join("・"));
})().catch((e) => { console.error(e); process.exit(1); });
