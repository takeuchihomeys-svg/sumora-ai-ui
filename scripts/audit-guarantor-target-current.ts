// scripts/audit-guarantor-target-current.ts — GUARANTOR_TARGET_CURRENT（束のうち今話している物件1件に絞る）の問題の組を本番から作り、off と on を当てる
//   （読むだけ・LLM なし・費用0・DB に書かない）
//
// 2026-11-20 作業員K2（統括役の決め: 試験の道が無いスイッチの問題を作る・最初は GUARANTOR_TARGET_CURRENT）。
//   問題: お客様の保証会社の質問（confirmObjectFromCustomerTurn＝保証会社）のうち、会話から決めた物件（resolveGuarantorTargets）が2件以上の番。
//   正解: 質問の後 72時間の、こちらの返信（最初の4通）に書いた物件（staffLabelsOf → propertyKeyOf.base）。返信に物件名が無い番は「正解なし」で数えるだけ。
//   on の材料は本番と同じ: ブレインの注目物件（その番より前で一番新しい brain_decision_logs の building_key＋room_no。本番は conversations の今の meta）と直近12通。
//   物差し: off＝束のまま（正解を含むか）／on＝絞った1件が正解か。**誤り＝絞った1件が返信の物件と違う**（出口ではなく先入れだが、誤り0を確かめてから on の案にする）。
//   出力: 数と、絞った番の一覧（会話の id の頭8字・時刻・束の数・絞った理由・正しいか）。物件名・お客様の文は出さない（--names で手元だけに出す）。
//   --out=<json> で問題の組（会話の id・質問の時刻・束・正解・on の答え）を手元に書く（.claude/exam-cache の下へ・git に入れない）。
// 11/20 の結果（365日）: 束が2件以上 8番・on で絞る 7番。返信の物件名で決まる正解は1番しか無く、8番を目で読んで答えの範囲を付けた
//   （.claude/exam-cache/guarantor-target/cases-1120.json の handGold）: on で正しい 2（同じ物件の表記ゆれ・竹内さん #29）／誤り 5
//   （お客様は「送った中で」「どこになるでしょうか」と束の全部を聞き、スタッフも全部答えた 3・束と関係ない質問 1・号室違い 1）。
//   絞りの手がかり「直近の会話で1件だけ名前が出た通」は、ほとんどが最後に送った見積の文＝お客様が聞いた物件ではない → 既定 off のまま。
//   直す案（未決）: 見積・資料の文（【物件名】・初期費用・御見積書同封）は手がかりにせず、こちらが1件を推した文（「〇〇は…お申込し抑え」）か
//   お客様の質問の文の物件名だけで絞る（#29 はお客様の文に物件名が無く、直前にこちらが Leaf Maison 大物を推した番）。
// 実行: npx tsx --env-file=.env.local scripts/audit-guarantor-target-current.ts [--days=365] [--names] [--out=<json>]
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveGuarantorTargets, guarantorQuestionIndex, narrowToCurrentProperty, type GuarantorTargetMsg } from "../app/lib/guarantor-target";
import { loadGuarantorTargetMessages } from "../app/lib/guarantor-prefill-server";
import { staffLabelsOf, propertyKeyOf } from "../app/lib/confirm-target-property";
import { confirmObjectFromCustomerTurn } from "../app/lib/action-ledger";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const days = Number(arg("days", "365"));
const SHOW_NAMES = process.argv.includes("--names");
const OUT = arg("out", "");
const since = new Date(Date.now() - days * 86400_000).toISOString();

type Case = { conv: string; at: string; batch: string[]; gold: string[]; onNames: string[]; narrowed: boolean; why: string | null; brainProp: string | null; offHasGold: boolean | null; onRight: boolean | null };

async function main() {
  const qs: Array<{ conversation_id: string; created_at: string; text: string }> = [];
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, created_at, text").eq("sender", "customer")
      .gte("created_at", since).ilike("text", "%保証会社%").order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as Array<{ conversation_id: string; created_at: string; text: string | null }>) {
      if (isTestConversation(m.conversation_id)) continue;
      if (confirmObjectFromCustomerTurn(m.text ?? "")?.object === "保証会社") qs.push({ ...m, text: m.text ?? "" });
    }
    if ((data ?? []).length < 1000) break;
  }
  // 同じ会話の続いた質問は最後の1通だけ（audit-guarantor-prefill と同じ）
  const uniq = qs.filter((q, i) => !(qs[i + 1] && qs[i + 1].conversation_id === q.conversation_id && Date.parse(qs[i + 1].created_at) - Date.parse(q.created_at) < 30 * 60_000));
  const cases: Case[] = [];
  let single = 0, none = 0;
  for (const q of uniq) {
    const msgs: GuarantorTargetMsg[] = await loadGuarantorTargetMessages(q.conversation_id, { before: q.created_at, limit: 80 });
    if (guarantorQuestionIndex(msgs) < 0) continue;
    const tg = resolveGuarantorTargets(msgs);
    if (tg.names.length <= 1) { if (tg.names.length === 1) single++; else none++; continue; }
    // その番より前で一番新しいブレインの注目物件（建物の鍵＋号室）
    const { data: bl } = await sb.from("brain_decision_logs").select("building_key, room_no, created_at").eq("conversation_id", q.conversation_id)
      .lte("created_at", q.created_at).not("building_key", "is", null).order("created_at", { ascending: false }).limit(1);
    const b = ((bl ?? []) as Array<{ building_key: string | null; room_no: string | null }>)[0];
    const brainProp = b?.building_key ? `${b.building_key}${b.room_no ? ` ${b.room_no}` : ""}` : null;
    const nr = narrowToCurrentProperty(tg.names, { currentProperty: brainProp, recentTexts: msgs.slice(-12).map((m) => m.text) });
    const { data: after } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", q.conversation_id)
      .gt("created_at", q.created_at).lte("created_at", new Date(Date.parse(q.created_at) + 72 * 3600_000).toISOString()).order("created_at").limit(30);
    const replies = ((after ?? []) as Array<{ sender: string; text: string | null }>).filter((m) => m.sender !== "customer").slice(0, 4).map((m) => m.text ?? "");
    // 号室の無い拾い（「現在」等の言葉）は物件ではない＝正解にしない（11/20 の1回目で「現在」を正解に拾った）
    const gold = [...new Set(replies.flatMap((r) => staffLabelsOf(r)).filter((l) => /[0-9０-９]/.test(l)).map((l) => propertyKeyOf(l).base))];
    const base = (n: string) => propertyKeyOf(n).base;
    const offHasGold = gold.length ? tg.names.some((n) => gold.includes(base(n))) : null;
    const onRight = gold.length && nr.narrowed ? gold.includes(base(nr.names[0])) : null;
    cases.push({ conv: q.conversation_id, at: q.created_at, batch: tg.names, gold, onNames: nr.names, narrowed: nr.narrowed, why: nr.why, brainProp, offHasGold, onRight });
  }
  const nar = cases.filter((c) => c.narrowed);
  const judged = nar.filter((c) => c.onRight !== null);
  console.log(`=== ${days}日・保証会社の質問 ${uniq.length}件（YUMA・テストの会話を除く）`);
  console.log(`物件の束が2件以上 ${cases.length}・1件 ${single}・決まらない ${none}`);
  console.log(`on で絞った ${nar.length}/${cases.length}（注目物件 ${nar.filter((c) => /注目/.test(c.why ?? "")).length}・直近の会話 ${nar.filter((c) => /直近/.test(c.why ?? "")).length}）`);
  console.log(`返信に物件名がある（正解あり）: 束 ${cases.filter((c) => c.gold.length).length}・絞った番 ${judged.length}`);
  console.log(`絞った1件が返信の物件と同じ ${judged.filter((c) => c.onRight).length}／違う（誤り） ${judged.filter((c) => !c.onRight).length}／正解なし ${nar.length - judged.length}`);
  console.log(`絞らなかった番で、束に返信の物件が入っている ${cases.filter((c) => !c.narrowed && c.offHasGold).length}/${cases.filter((c) => !c.narrowed && c.offHasGold !== null).length}`);
  console.log("\n--- 絞った番（会話の頭8字・時刻・束の数・理由・正しいか）");
  for (const c of nar) console.log(`${c.onRight === null ? "？" : c.onRight ? "○" : "★✕"} ${c.conv.slice(0, 8)} ${c.at.slice(0, 16)} 束${c.batch.length} ${c.why}${SHOW_NAMES ? `｜束=${c.batch.join("・")}｜絞った=${c.onNames[0]}｜返信=${c.gold.join("・") || "-"}｜注目=${c.brainProp ?? "-"}` : ""}`);
  if (OUT) { writeFileSync(OUT, JSON.stringify({ made: new Date().toISOString(), days, cases }, null, 1)); console.log(`\n問題の組 ${cases.length} → ${OUT}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
