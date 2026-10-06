// scripts/audit-pickup-wants-claims.ts — 束の実物に無い特徴を書いたか（pickup-wants-fit.findUnmetWantClaims）を過去の物件ピックアップで数える（読むだけ・LLM なし）
// 2026-10-07 竹内（Ryoichi kiritsuke 10/05「築浅またはリノベのお部屋」・束にリノベ済み 0）:
//   売上サポから送った束（property_pickups の status=sent・同じ会話×同じ sent_at）ごとに、その時の AI の下書き（aix_generate_log property_send・送付の前15分）と
//   スタッフが送った文（messages・送付の前後3分の staff の「ピックアップ」）を照らし、
//   ①AI の下書きで注意が出る通 ②スタッフの送った文で注意が出る通（＝誤検出の候補・目で読む）を全部出す。
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-wants-claims.ts [--days=60] [--conv=<会話id>]
import { createClient } from "@supabase/supabase-js";
import { parsePickupFact } from "../app/lib/pickup-send-facts";
import { bundleWantsFit, buildBundleFitNote, customerWantsForFit, findUnmetWantClaims, pickupFitInputFromRow } from "../app/lib/pickup-wants-fit";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "60");
const CONV = process.argv.find((a) => a.startsWith("--conv="))?.slice(7) ?? null;
const SHOW_NOTE = process.argv.includes("--note");

type Row = { id: number; conversation_id: string | null; sent_at: string | null; property_name: string | null; summary_text: string | null; image_lines: string[] | null; pdf_text: string | null; terms: Record<string, unknown> | null; equipment: Record<string, unknown> | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Row[] = [];
  for (let i = 0; ; i += 500) {
    let q = sb.from("property_pickups").select("id, conversation_id, sent_at, property_name, summary_text, image_lines, pdf_text, terms, equipment")
      .eq("status", "sent").gte("sent_at", since).order("sent_at").range(i, i + 499);
    if (CONV) q = q.eq("conversation_id", CONV);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 500) break;
  }
  const bundles = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.conversation_id || !r.sent_at || isTestConversation(r.conversation_id)) continue;
    const k = `${r.conversation_id}|${r.sent_at.slice(0, 19)}`;
    bundles.set(k, [...(bundles.get(k) ?? []), r]);
  }
  let nB = 0, withCond = 0, draftHit = 0, sentHit = 0, renoBundles = 0;
  for (const [k, b] of bundles) {
    if (b.length < 2) continue; // 束（2部屋以上）だけ
    nB++;
    const [conv, at] = k.split("|");
    const t = Date.parse(at + "Z");
    const { data: gens } = await sb.from("aix_generate_log").select("generated_text, conditions_snapshot, created_at").eq("conversation_id", conv).eq("action_type", "property_send")
      .gte("created_at", new Date(t - 15 * 60_000).toISOString()).lte("created_at", new Date(t + 60_000).toISOString()).order("created_at", { ascending: false }).limit(1);
    const gen = (gens ?? [])[0] as { generated_text: string | null; conditions_snapshot: { customer_conditions?: string | null } | null } | undefined;
    const cond = gen?.conditions_snapshot?.customer_conditions ?? null;
    if (!cond) continue;
    withCond++;
    const { data: msgs } = await sb.from("messages").select("text, created_at").eq("conversation_id", conv).eq("sender", "staff")
      .gte("created_at", new Date(t - 3 * 60_000).toISOString()).lte("created_at", new Date(t + 3 * 60_000).toISOString()).ilike("text", "%ピックアップ%").limit(3);
    const sent = ((msgs ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n");
    const fit = bundleWantsFit(b.map((r) => pickupFitInputFromRow(r as never, parsePickupFact(r), null)), customerWantsForFit(cond));
    if (fit.wants.some((w) => w.key === "renovation")) renoBundles++;
    const d = gen?.generated_text ? findUnmetWantClaims(gen.generated_text, fit) : null;
    const s = sent ? findUnmetWantClaims(sent, fit) : null;
    if (d) draftHit++;
    if (s) sentHit++;
    if (d || s || CONV) {
      console.log(`\n■ ${conv.slice(0, 8)} ${at} ${b.length}部屋 要望: ${fit.wants.map((w) => `${w.label}:${w.verdict}(${w.ok}/${w.ng}/${w.unknown})${w.info ? "[数]" : ""}`).join(" ")}`);
      console.log(`  条件: ${JSON.stringify(cond).slice(0, 160)}`);
      console.log(`  下書き${d ? "⚠" : "  "}: ${JSON.stringify(gen?.generated_text ?? "").slice(0, 220)}`);
      console.log(`  送信  ${s ? "⚠" : "  "}: ${JSON.stringify(sent).slice(0, 220)}`);
      if (d) console.log(`  注意(下書き): ${d}`);
      if (s) console.log(`  注意(送信): ${s}`);
      if (SHOW_NOTE || CONV) console.log(`  注記:\n${buildBundleFitNote(fit).split("\n").map((l) => "    " + l).join("\n")}`);
    }
  }
  console.log(`\n束 ${nB}・条件つきの下書きあり ${withCond}・リノベの希望 ${renoBundles}・注意が出る: 下書き ${draftHit}／スタッフの送信 ${sentHit}（送信の当たりは誤検出の候補＝目で読む）`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
