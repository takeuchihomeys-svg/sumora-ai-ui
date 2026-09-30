// scripts/audit-second-message-exit.ts — 2通目の出口（別の物件の号室・作業メモ）を実送信に当てる（読むだけ）
// 2026-09-30 YUMA の実送信テスト（物件オススメ → 2通目）で入れた線が、スタッフの実際の2通目を誤って止めないか。
//   組: こちらの AIX の1通目（物件が読める）→ 間にお客様の発言なしで 15分以内に続けて送った2通目。
//   ① foreignRoomsInSecond（1通目に無い号室） ② isNotACustomerReply ③ stripMetaNarration が当たる2通目を数え、実物を出す。
// 実行: npx tsx --env-file=.env.local scripts/audit-second-message-exit.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { foreignRoomsInSecond, readFirstMessage } from "../app/lib/aix-chain-note";
import { isNotACustomerReply, stripMetaNarration } from "../app/lib/meta-narration";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.slice(2).find((a) => a.startsWith("--days="))?.slice(7) ?? "365") || 365;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: M[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("conversation_id").order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as M[]));
    if (!data || data.length < 1000) break;
  }
  let pairs = 0, foreign = 0, notReply = 0, meta = 0, staffAll = 0, staffNotReply = 0;
  const show: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (a.conversation_id === YUMA || a.sender !== "staff" || !a.text || a.text === "[画像]") continue;
    staffAll++;
    if (isNotACustomerReply(a.text)) { staffNotReply++; if (show.length < 40) show.push(`[返信でない判定] ${a.created_at.slice(0, 16)} ${a.text.replace(/\n/g, "／").slice(0, 140)}`); }
    if (!a.is_aix_generated || readFirstMessage(a.text).propertyLabels.length === 0) continue;
    const b = rows[i + 1];
    if (!b || b.conversation_id !== a.conversation_id || b.sender !== "staff" || !b.text || b.text === "[画像]") continue;
    if (Date.parse(b.created_at) - Date.parse(a.created_at) > 15 * 60_000) continue;
    pairs++;
    const f = foreignRoomsInSecond(b.text, a.text);
    if (f.length) { foreign++; if (show.length < 40) show.push(`[別の号室 ${f.join(",")}] 1通目: ${readFirstMessage(a.text).propertyLabels.join("・")} ／ 2通目: ${b.text.replace(/\n/g, "／").slice(0, 160)}`); }
    if (isNotACustomerReply(b.text)) notReply++;
    if (stripMetaNarration(b.text).removed.length) meta++;
  }
  console.log(`直近${DAYS}日: スタッフの送信 ${staffAll}通（返信でない判定 ${staffNotReply}）／AIX の1通目（物件あり）→ 続けて送った2通目 ${pairs}組: 別の号室 ${foreign}・返信でない ${notReply}・作業メモの行 ${meta}`);
  for (const s of show) console.log("  " + s);
}
main().catch((e) => { console.error(e); process.exit(1); });
