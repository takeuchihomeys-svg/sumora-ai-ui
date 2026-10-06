// scripts/audit-viewing-property-candidates.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-property-candidates.ts   （DAYS=120 既定・読み取りのみ・DUMP=1 で全件）
//       CONV=1191b1eb-… …… その会話の今の候補だけを出す
//
// 2026-10-06 竹内（ゆいと・チンシャン事例）「送った物件選択してそこから おこなえるようにする（見積書作成の時のように）」:
//   過去の AIX【待ち合わせ】の実送信（「…に〇〇／現地エントランスお待ち合わせ」）の直前の時刻で、見積書作成と同じ材料（loadEstimateHandoff asOf）から
//   候補（viewing-property-candidates）を作り、
//     ① 待ち合わせに書いた物件が候補にあるか（＝押して選べたか）
//     ② 先に選んだ物（preselect・推測しない）が書いた物件と合うか／違うか／選ばない
//     ③ 候補の資料の所在地が番地まであるか
//   を数え、外れの実物を読む。
import { loadEstimateHandoff } from "../app/lib/estimate-handoff-server";
import { viewingCandidatesFromChoice, preselectViewingCandidates, candidateMatchesName, latestCustomerTurnStartAt } from "../app/lib/viewing-property-candidates";
import { latestCustomerTurnText } from "../app/lib/viewing-date-request";
import { supabase } from "../app/lib/supabase";

const DAYS = Number(process.env.DAYS ?? 120);
const DUMP = process.env.DUMP === "1";
const CONV = process.env.CONV ?? "";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const jst = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

async function main() {
  if (CONV) {
    const h = await loadEstimateHandoff(CONV);
    const cands = viewingCandidatesFromChoice(h?.choice);
    const { data } = await supabase.from("messages").select("sender, text, created_at").eq("conversation_id", CONV).order("created_at", { ascending: false }).limit(40);
    const turn = latestCustomerTurnText([...(data ?? [])].reverse() as Array<{ sender: string; text: string | null }>);
    console.log(`候補 ${cands.length}件（お客様の最新の発言「${turn.slice(0, 40)}」）`);
    for (const c of cands) console.log(`  ${c.customerPointed ? "💬" : "  "} ${c.label}｜${c.sourceLabel}｜所在地 ${c.address || "なし"}${c.address && !c.addressHasBanchi ? "（番地なし）" : ""}｜資料 ${c.imageUrl ? "あり" : "なし"}`);
    for (const mode of ["meeting", "guide", "invite"] as const) {
      const p = preselectViewingCandidates(cands, { mode, customerText: turn, turnStartAt: latestCustomerTurnStartAt([...(data ?? [])].reverse()) });
      console.log(`  先に選ぶ（${mode}）: ${p.keys.map((k) => cands.find((c) => c.key === k)?.label).join("・") || "なし"}｜${p.reason}`);
    }
    return;
  }
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data: rows, error } = await supabase.from("messages").select("conversation_id, text, created_at")
    .eq("sender", "staff").like("text", "%現地エントランスお待ち合わせ%").gte("created_at", since).order("created_at").limit(1000);
  if (error) throw new Error(error.message);
  const list = (rows ?? []).filter((r) => r.conversation_id !== YUMA) as Array<{ conversation_id: string; text: string; created_at: string }>;
  let withImage = 0, inCands = 0, preHit = 0, preMiss = 0, preNone = 0, banchi = 0, noName = 0, noCands = 0;
  const out: string[] = [];
  for (const r of list) {
    const m = r.text.match(/[0-9０-９:：]{3,5}\s*(?:〜|~)?\s*に\s*([^\n]+?)\s*\n\s*現地エントランス/);
    const wrote = m?.[1]?.trim() ?? "";
    if (!wrote) { noName++; continue; }
    const asOf = new Date(Date.parse(r.created_at) - 1000).toISOString();
    const h = await loadEstimateHandoff(r.conversation_id, { asOf });
    const cands = viewingCandidatesFromChoice(h?.choice);
    if (!cands.length) noCands++;
    const hit = cands.find((c) => candidateMatchesName(c, wrote));
    if (hit) { inCands++; if (hit.addressHasBanchi) banchi++; if (hit.imageUrl) withImage++; }
    const { data: ms } = await supabase.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id).lt("created_at", r.created_at).order("created_at", { ascending: false }).limit(30);
    const turn = latestCustomerTurnText([...(ms ?? [])].reverse() as Array<{ sender: string; text: string | null }>);
    const p = preselectViewingCandidates(cands, { mode: "meeting", customerText: turn, turnStartAt: latestCustomerTurnStartAt([...(ms ?? [])].reverse()) });
    const pre = cands.find((c) => p.keys.includes(c.key));
    let verdict: string;
    if (!pre) { preNone++; verdict = "先に選ばない"; }
    else if (candidateMatchesName(pre, wrote)) { preHit++; verdict = "先に選んだ＝書いた物件"; }
    else { preMiss++; verdict = `先に選んだ「${pre.label}」≠ 書いた物件`; }
    if (DUMP || !hit || (pre && !candidateMatchesName(pre, wrote))) {
      out.push(`  ${jst(r.created_at)} ${r.conversation_id.slice(0, 8)} 書いた「${wrote}」｜候補に${hit ? "あり" : "なし"}（${cands.length}件: ${cands.slice(0, 4).map((c) => c.label).join("・")}）｜${verdict}｜客「${turn.replace(/\n/g, " ").slice(0, 30)}」`);
    }
  }
  const n = list.length - noName;
  console.log(`AIX【待ち合わせ】の実送信 ${list.length}通（${DAYS}日・YUMA 除く・物件名の読めない ${noName}通を除く ${n}通）`);
  console.log(`  ① 書いた物件が候補にあった: ${inCands}/${n}（候補が0件 ${noCands}）`);
  console.log(`  ② 先に選んだ＝書いた物件 ${preHit}／違う物件 ${preMiss}／先に選ばない ${preNone}`);
  console.log(`  ③ 候補にあった物件の資料の所在地が番地まで: ${banchi}/${inCands}（資料の画像あり ${withImage}/${inCands}＝所在地が無い時は押した時に画像を読み取りに通す）`);
  console.log("\n候補に無かった・先に選んだ物が違った回:");
  for (const s of out) console.log(s);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
