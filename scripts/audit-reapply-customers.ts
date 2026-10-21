// 申込歴あり（再探し）の会話の数・戻った理由の分布・戻った会話の DeepSeek に渡る材料の自己点検（読み取りのみ・件数と会話ID 先頭8桁だけ・本文は出さない）
//
// 2026-10-21 竹内さんの決定（70193195・c2909936・023ec7bd）:
//   ① 申込歴あり（resolveReapply）の会話はいくつか・戻った理由（①否決 ②1番手が通過 ③切り替え／理由不明）の分布
//   ② 印だけ残って戻した会話（badgeMovedBackForDeepseek）＝今回 DeepSeek の線を当てる会話はどれか
//   ③ 線のある会話（戻した会話すべて）で、線より後に残る材料（返信の窓＝直近25件・申込期間のまとめ）に
//      申込期間の通（線より前）が入らないこと・申込情報の名残（altPiiSignalReapply）・審査の事情（screening-sensitive）が無いか。
//      当たる会話は出口で Claude に戻る（＝DeepSeek には出ない）ので数だけ出す
// 実行: npx tsx --env-file=.env.local scripts/audit-reapply-customers.ts
import { createClient } from "@supabase/supabase-js";
import { loadPostApplyFacts, deepseekSafeCutoff, cutoffMs, filterAfterCutoff, badgeMovedBackForDeepseek, badgeMovedBackCore, NO_CUTOFF } from "../app/lib/post-apply";
import { resolveReapply } from "../app/lib/reapply-customer";
import { loadReapplyInfo } from "../app/lib/reapply-customer-server";
import { altPiiSignalReapply } from "../app/lib/alt-pii-gate";
import { screeningSensitiveSignal } from "../app/lib/screening-sensitive";
import { maskPII } from "../app/lib/pii-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const id8 = (s: string) => s.slice(0, 8);

async function main() {
  const rows: Array<{ id: string; status: string | null; is_post_apply: boolean | null; customer_name: string | null }> = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await sb.from("conversations").select("id, status, is_post_apply, customer_name")
      .or("status_manual_back_at.not.is.null,deepseek_cutoff_at.not.is.null").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const dist: Record<string, number> = {}, src: Record<string, number> = {};
  const reapply: Array<{ id: string; pattern: string; badge: boolean; ds: boolean }> = [];
  for (const r of rows) {
    const facts = await loadPostApplyFacts(sb, r.id).catch(() => null);
    if (!facts) continue;
    const st = resolveReapply(facts);
    if (!st.reapply) continue;
    const info = await loadReapplyInfo(sb, r.id);
    const p = info?.pattern ?? "unknown";
    dist[p] = (dist[p] ?? 0) + 1;
    src[info?.source ?? "none"] = (src[info?.source ?? "none"] ?? 0) + 1;
    reapply.push({ id: r.id, pattern: p, badge: badgeMovedBackCore(facts), ds: badgeMovedBackForDeepseek(facts, { REAPPLY_DEEPSEEK: "on" }) });
  }
  console.log(`── ① 申込歴あり（再探し）: ${reapply.length} 会話（戻しの印・切り替えの時刻のある ${rows.length} 会話のうち）`);
  console.log("   戻った理由:", JSON.stringify(dist), " 読み方:", JSON.stringify(src));
  console.log(`── ② 印だけ残って戻した会話: ${reapply.filter((x) => x.badge).length}（うち DeepSeek の線を当てる＝戻しの印あり ${reapply.filter((x) => x.ds).length}）`,
    reapply.filter((x) => x.badge).map((x) => `${id8(x.id)}${x.ds ? "*" : ""}:${x.pattern}`).join(" "));

  // ③ 自己点検（REAPPLY_DEEPSEEK=on の線で）
  process.env.REAPPLY_DEEPSEEK = "on";
  let checked = 0, leakPre = 0, piiConv = 0, sensConv = 0, sumBad = 0, blockedLine = 0;
  const piiKinds: Record<string, number> = {};
  const rowsOut: string[] = [];
  for (const x of reapply) {
    const facts = await loadPostApplyFacts(sb, x.id);
    const cut = deepseekSafeCutoff(facts, { reapply: true });
    const line = cutoffMs(cut);
    if (line === null) { blockedLine++; continue; }
    checked++;
    const { data: msgs } = await sb.from("messages").select("sender, text, created_at, image_type").eq("conversation_id", x.id).order("created_at", { ascending: false }).limit(25);
    const win = ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string; image_type: string | null }>).reverse();
    const after = filterAfterCutoff(win, (m) => m.created_at, cut);
    // 線より前（申込期間を含む）の通が残っていないか
    const pre = line === NO_CUTOFF ? 0 : after.filter((m) => Date.parse(m.created_at) <= line).length;
    if (pre) leakPre++;
    const kinds = new Set<string>();
    let sens = false;
    for (const m of after) {
      const masked = maskPII(String(m.text ?? ""), []);
      const k = altPiiSignalReapply(masked);
      if (k) kinds.add(k);
      if (m.image_type === "id_document" || m.image_type === "income_document") kinds.add("書類の画像");
      if (m.sender === "customer" && screeningSensitiveSignal(m.text)) sens = true;
    }
    if (kinds.size) { piiConv++; for (const k of kinds) piiKinds[k] = (piiKinds[k] ?? 0) + 1; }
    if (sens) sensConv++;
    const { data: sum } = await sb.from("apply_period_summaries").select("status, block").eq("conversation_id", x.id).maybeSingle();
    const s = sum as { status?: string; block?: string | null } | null;
    if (s?.status === "ok" && s.block && altPiiSignalReapply(s.block)) sumBad++;
    rowsOut.push(`${id8(x.id)}${x.badge ? "(印)" : ""}: 窓${win.length}→線の後${after.length}・線より前0=${pre === 0}・名残${kinds.size ? [...kinds].join("/") : "なし"}・審査の事情${sens ? "あり" : "なし"}・まとめ${s?.status ?? "なし"}`);
  }
  console.log(`── ③ 線のある会話の自己点検: 点検 ${checked}（線が引けない＝Claude 固定 ${blockedLine}）`);
  console.log(`   線より前の通が残った会話: ${leakPre}／申込情報の名残がある会話（出口で Claude に戻る）: ${piiConv} ${JSON.stringify(piiKinds)}／審査の事情（Claude）: ${sensConv}／渡すまとめに名残: ${sumBad}`);
  for (const l of rowsOut) console.log("   ", l);
}
main().catch((e) => { console.error(e); process.exit(1); });
