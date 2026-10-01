// 見積書作成の引き継ぎ（/api/estimate-handoff と同じ loadEstimateHandoff）を会話ごとに出して目で読む（読むだけ・LLM なし・書かない）
// 2026-10-01 竹内「見積書きかれたら…見積書のツールに連携・送った物件がセットされた状態で」
//
// 実行:
//   npx tsx --env-file=.env.local scripts/try-estimate-handoff.ts <conversation_id> [...]
//   npx tsx --env-file=.env.local scripts/try-estimate-handoff.ts --recent=20   直近の AIX【見積書送る】の会話を、見積書の直前の状態ではなく「今」で当てる
//   npx tsx --env-file=.env.local scripts/try-estimate-handoff.ts --audit=40    直近の見積書を「送る3分前の記録」で決め直し、実際の見積書の物件名と突き合わせる（会話ごとに最新の1通）
//
// 2026-10-01 の当て直し（--audit=60・会話ごとに最新の見積書の回・送る3分前の記録で決め直す）:
//   自動で選んだお部屋が実際の見積書と一致 28/60（47%）・お客様の持ち込み（名前は画像・リンクから読む）8・
//   回の候補に入る 4・「選び直す」の一覧に入る 4 → 1タップ以内で届く 44/60（73%）／違うお部屋 12（20%）／出来事なし 4
//   出所別の一致: 引用 8/11・🌟 9/14・名前を書いた 3/4・送付1件 2/3・主のお部屋（customer-state）0/1
//   旧（customer-state の主のお部屋だけ）は 8/40 ＝ 出来事（引用・名前・持ち込み・🌟）の新しい順に変えた
import { createClient } from "@supabase/supabase-js";
import { loadEstimateHandoff } from "../app/lib/estimate-handoff-server";
import { parseEstimateItems } from "../app/lib/estimate-profit";
import { matchKnownProperty } from "../app/lib/property-name-match";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

async function show(id: string, expect?: string[], asOf?: string) {
  const h = await loadEstimateHandoff(id, asOf ? { asOf } : {});
  if (!h) { console.log(id.slice(0, 8), "not found"); return null; }
  const t = h.choice.target;
  console.log(`\n■ ${id.slice(0, 8)} ${h.customerName}（${h.account}）段階=${h.watch.stageLabel ?? "-"} ブレイン=${h.watch.brain?.action ?? "-"} 入口=${h.watch.entry.show ? h.watch.entry.mode : "なし"} 抑えたい=${h.watch.lowInitialCost ? "○" : "×"}`);
  if (t) {
    console.log(`  物件: ${t.name} ${t.room ?? ""}（${t.sourceLabel}）資料 ${t.materials.length}枚${t.materialText ? "＋文字" : ""} 家賃=${t.rent ?? "?"} AD=${t.adMonths ?? "?"}ヶ月/${t.adYen ?? "?"}円（${t.adSource ?? "-"}${t.adLabel ? `・${t.adLabel}` : ""}）自動読み取り=${h.choice.autoExtract ? "○" : "×"}`);
  } else {
    console.log(`  物件: なし 候補=${h.choice.candidates.map((c) => `${c.name} ${c.room ?? ""}`).join("／") || "なし"}`);
  }
  if (h.discount) console.log(`  割引の目安: ${h.discount.yen.toLocaleString()}円（${h.discount.basis}・${h.discount.lowYen.toLocaleString()}〜${h.discount.highYen.toLocaleString()}）${h.discount.profitYen != null ? ` 利益 ${h.discount.profitYen.toLocaleString()}円` : ""}${h.discount.warning ? ` ⚠${h.discount.warning}` : ""}`);
  for (const w of h.choice.warnings) console.log(`  ⚠ ${w}`);
  if (expect?.length) {
    const tHit = !!t && t.name.length >= 2 && expect.some((e) => matchKnownProperty(e, [t.name], 0.7));
    const cHit = expect.some((e) => matchKnownProperty(e, h.choice.candidates.map((c) => c.name).filter((x) => x.length >= 2), 0.7));
    // 名前の無い持ち込み（画像だけ）は画像を渡せていれば「画像あり」（AI 読み取りで名前が出る＝外れではない）
    const unnamedBrought = !!t && !t.name && t.source === "customer_brought" && (t.materials.length > 0 || !!t.link);
    const oHit = expect.some((e) => matchKnownProperty(e, h.choice.others.map((c) => c.name), 0.7));
    // 名前も画像も残っていない持ち込み（出所は正しい・古い画像は URL が消えている）＝brought_unnamed
    const unnamedNoMaterial = !!t && !t.name && t.source === "customer_brought" && t.materials.length === 0 && !t.link;
    const res = tHit ? "match" : unnamedBrought ? "brought_image" : unnamedNoMaterial ? "brought_unnamed" : cHit ? "candidate" : oHit ? "in_others" : t ? "differ" : "none";
    console.log(`  実際の見積書[${id.slice(0, 8)}]: ${expect.join("・")} → ${res}`);
    return `${t?.source ?? "-"}:${res}`;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const recent = Number((args.find((a) => a.startsWith("--recent=")) ?? "").split("=")[1] || 0);
  const audit = Number((args.find((a) => a.startsWith("--audit=")) ?? "").split("=")[1] || 0);
  if (recent || audit) {
    const n = recent || audit;
    const { data } = await sb.from("aix_usage_logs").select("conversation_id, created_at, generated_text").eq("aix_type", "estimate_sheet").neq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(n * 6);
    const seen = new Set<string>();
    const tally: Record<string, number> = {};
    const rows = (data ?? []) as Array<{ conversation_id: string; created_at: string; generated_text: string | null }>;
    for (const r of rows) {
      if (seen.has(r.conversation_id)) continue;
      const items = parseEstimateItems(r.generated_text).filter((i) => i.propertyName);
      if (!items.length) continue;
      seen.add(r.conversation_id);
      // 同じ会話で20分以内に続けて送った見積書は1回（複数のお部屋を続けて作る）。その回の最初の3分前の記録で決め直す
      const session = rows.filter((x) => x.conversation_id === r.conversation_id && Math.abs(new Date(x.created_at).getTime() - new Date(r.created_at).getTime()) <= 20 * 60e3);
      const first = session.reduce((a, b) => (a.created_at < b.created_at ? a : b));
      const names = [...new Set(session.flatMap((x) => parseEstimateItems(x.generated_text).map((i) => i.propertyName)).filter(Boolean))];
      const asOf = audit ? new Date(new Date(first.created_at).getTime() - 3 * 60e3).toISOString() : undefined;
      const res = await show(r.conversation_id, audit ? names : undefined, asOf);
      if (res) tally[res] = (tally[res] ?? 0) + 1;
      if (seen.size >= n) break;
    }
    if (audit) console.log("\n集計:", tally);
    return;
  }
  for (const id of args.length ? args : [YUMA]) await show(id);
}
main().catch((e) => { console.error(e); process.exit(1); });
