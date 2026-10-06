// scripts/audit-promise-aix-rerequest.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-aix-rerequest.ts [--days=180]
//
// 2026-10-06 竹内（R 事例）: 確認の約束（条件・設備）の後にお客様が同じ要件をお願いしただけ（「エアコンの件よろしくお願いします！」）の番で、
//   約束の AIX【確認した（条件・交渉）→〈要件〉】が立たず物件ピックアップになっていた（aix-task-link resolveStaffPromiseAix の入口）。
// 線: こちらの確認の約束の直後のお客様の連投ごとに、旧（HEAD）と新の約束の AIX を並べ、変わった番を全部出す（その後スタッフが実際に何を送ったかも）。
//   読み取りのみ・LLM なし。出力は会話の文を含むので共有しない。
//   旧（10/06 の直す前）は「お客様の番がお礼・了承だけ」の時しか約束の AIX が立たなかった＝お礼だけでない番で立つ物が今回の直しで変わった番。
//   10/06 の実行（180日）: 確認の約束のある会話 173・約束直後のお客様の番 349・変わった番 2（9d5c3c23 浴室乾燥・ac7c7fd3 R エアコン）＝どちらもスタッフが翌日 確認結果を報告
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger, classifyStaffTextFacts } from "../app/lib/action-ledger";
import { resolveStaffPromiseAix } from "../app/lib/aix-task-link";
import { analyzeSubstance } from "../app/lib/reply-context";
import { customerRequestedPropertyCheck } from "../app/lib/aix-scene-evidence";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").split("=")[1]);
const since = new Date(Date.now() - days * 86400_000).toISOString();
type M = { sender: string; text: string | null; createdAt: string; isAix: boolean };

async function main() {
  // 確認の約束を含むこちらの発言（候補）
  const cands: Array<{ conversation_id: string; created_at: string; text: string | null }> = [];
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, created_at, text").eq("sender", "staff").gte("created_at", since)
      .or("text.ilike.%確認%ご連絡%,text.ilike.%確認出来次第%,text.ilike.%確認でき次第%,text.ilike.%確認させて%").order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    cands.push(...data);
    if (data.length < 1000) break;
  }
  const convs = [...new Set(cands.filter((c) => classifyStaffTextFacts(c.text ?? "", c.created_at).some((e) => e.kind === "confirmation_promised")).map((c) => c.conversation_id))];
  let turns = 0, changed = 0;
  for (const conv of convs) {
    const { data } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", conv).order("created_at").limit(2000);
    const all: M[] = (data ?? []).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }));
    for (let i = 1; i < all.length; i++) {
      // お客様の連投の最後の通（次がお客様でない）で、連投の直前がこちらの確認の約束
      if (all[i].sender !== "customer" || all[i + 1]?.sender === "customer") continue;
      if (all[i].createdAt < since) continue;
      let s = i; while (s - 1 >= 0 && all[s - 1].sender === "customer") s--;
      const prevStaff = all[s - 1];
      if (!prevStaff || prevStaff.sender !== "staff") continue;
      if (!classifyStaffTextFacts(prevStaff.text ?? "", prevStaff.createdAt).some((e) => e.kind === "confirmation_promised")) continue;
      turns++;
      const msgs = all.slice(0, i + 1);
      const turnText = msgs.slice(s).map((m) => m.text ?? "").join("\n");
      const ack = !!turnText.trim() && analyzeSubstance(turnText, [turnText]).isAckOnly;
      const basisIdx = msgs.map((m) => m.sender).lastIndexOf("staff");
      const basis = ack ? msgs.slice(0, basisIdx + 1) : msgs;
      const req = customerRequestedPropertyCheck({ recentMessages: basis.map((m) => ({ sender: m.sender, text: m.text })), sentPropertyCount: 0 });
      const nl = buildActionLedger({ messages: msgs } as never);
      const n = resolveStaffPromiseAix(nl.facts, basis, { customerRequestedCheck: req, customerAckAfter: ack, propertyInPlay: true });
      const sig = (x: typeof n) => x ? `${x.action}${x.checkPattern ? `→${x.checkPattern}` : ""}` : "なし";
      // 旧の入口（最後がお客様ならお礼・了承だけの時しか立たない）で外れていた番だけ
      const lastNonMedia = [...basis].reverse().find((m) => (m.text ?? "").trim() && !/^\[(?:画像|動画|スタンプ|ファイル)\]/.test((m.text ?? "").trim()));
      if (!n || ack || lastNonMedia?.sender !== "customer") continue;
      const o: ReturnType<typeof resolveStaffPromiseAix> = null;
      changed++;
      const next = all.slice(i + 1).find((m) => m.sender === "staff" && m.text && m.text !== "[画像]");
      console.log(`■ ${conv.slice(0, 8)} ${all[i].createdAt.slice(0, 16)}｜旧 ${sig(o)} → 新 ${sig(n)}\n  約束: ${String(prevStaff.text ?? "").replace(/\n/g, " ／ ").slice(0, 160)}\n  お客様: ${turnText.replace(/\n/g, " ／ ").slice(0, 160)}\n  次のこちら(${next?.isAix ? "AIX" : "手打ち"} ${next?.createdAt.slice(5, 16) ?? "-"}): ${String(next?.text ?? "").replace(/\n/g, " ／ ").slice(0, 160)}`);
    }
  }
  console.log(`=== ${days}日: 確認の約束のある会話 ${convs.length}・約束直後のお客様の番 ${turns}・約束の AIX が変わった番 ${changed} ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
