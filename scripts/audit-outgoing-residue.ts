// scripts/audit-outgoing-residue.ts — 送る直前の最後の網（app/lib/outgoing-residue.ts）が人の送信に当たらないかを数える（読むだけ・LLM なし）
// 2026-10-02 竹内「監視が防げる部分」「テスト送信入っている。紛れないように」:
//   本番のスタッフの送信（人の手打ち＋AIX）を全部 detectOutgoingResidue に通し、当たった通を全部出す（目で読む）。
//   誤検出（人の文に当たる）が 0 でなければ網に入れない。YUMA・テストの会話は数えない。
// 実行: npx tsx --env-file=.env.local scripts/audit-outgoing-residue.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { detectOutgoingResidue } from "../app/lib/outgoing-residue";
import { isTestConversation } from "../app/lib/test-conversations";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; created_at: string; text: string | null; is_aix_generated: boolean | null }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, created_at, text, is_aix_generated").eq("sender", "staff").gte("created_at", since).order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  let human = 0, aix = 0, hitHuman = 0, hitAix = 0, yuma = 0;
  const byKind: Record<string, number> = {};
  for (const r of rows) {
    if (!r.text || /^\[(?:画像|動画|スタンプ|ファイル|通話)/.test(r.text)) continue;
    const hits = detectOutgoingResidue(r.text);
    if (isTestConversation(r.conversation_id)) { if (hits.length) yuma++; continue; }
    if (r.is_aix_generated) aix++; else human++;
    if (!hits.length) continue;
    if (r.is_aix_generated) hitAix++; else hitHuman++;
    for (const h of hits) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
    console.log(`\n${r.is_aix_generated ? "AIX" : "人 "} ${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)} ${hits.map((h) => `${h.kind}「${h.match}」`).join(" ")}\n  ${r.text.replace(/\n/g, "⏎").slice(0, 240)}`);
  }
  console.log(`\n=== ${DAYS}日・本番のスタッフの送信: 人の手打ち ${human}通 → 当たり ${hitHuman}／AIX ${aix}通 → 当たり ${hitAix}（種類 ${JSON.stringify(byKind)}）・テストの会話で当たり ${yuma}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
