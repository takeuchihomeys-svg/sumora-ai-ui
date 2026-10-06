// scripts/audit-pickup-adapt-now.ts
// 会話を合わせるの物件ピックアップ（aix_usage_logs property_send・conversation_match=true）で、生成に届く「最新のやり取り」を
// 前（会話の糸口 extractPropertySendThreads だけ）と後（＋property-send-now の今の場面）で比べる（読むだけ・LLM なし・費用0）。
//   ①最新のやり取りが1つも届かない回（糸口が無し）の数
//   ②スタッフが足した行の言葉（4文字の並び）が、生成への入力（糸口／今の場面）にあった回の数＝AI が知り得たか
//   ③送り方が新着の回で、新着の言い方に固定する／しないとスタッフの文の一致
// 2026-10-06 ⑰（あかりさんの事例）
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-adapt-now.ts [--days=60]
import { createClient } from "@supabase/supabase-js";
import { extractPropertySendThreads, buildPropertySendThreadsBlock } from "../app/lib/property-send-match";
import { readSendNow, effectiveSendFrame, buildSendNowBlock } from "../app/lib/property-send-now";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "60"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const norm = (s: string) => String(s ?? "").replace(EMOJI, "").replace(/[\s　！!。、・]+/g, "");
const lines = (s: string) => String(s ?? "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
/** スタッフが足した行（下書きに無い行）の中身の4文字の並び（名前・定型の語を除く） */
const STOP = /お世話|ご査収|お手隙|お待たせ|ピックアップ|させて頂|させていただ|オススメ|おすすめ|お部屋|さん|夜分|失礼/;
function grams(s: string): string[] {
  const t = norm(s).replace(/[0-9０-９]+/g, "#");
  const out: string[] = [];
  for (let i = 0; i + 4 <= t.length; i++) { const g = t.slice(i, i + 4); if (!STOP.test(g) && !/^[ぁ-ん#]+$/.test(g)) out.push(g); }
  return out;
}

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const { data: logs, error } = await sb.from("aix_usage_logs").select("conversation_id, created_at, send_mode").eq("aix_type", "property_send").eq("conversation_match", true)
    .gte("created_at", since).neq("conversation_id", YUMA_CONVERSATION_ID).order("created_at").limit(500);
  if (error) throw new Error(error.message);
  let n = 0, emptyBefore = 0, emptyAfter = 0, addedCases = 0, knownBefore = 0, knownAfter = 0;
  let naN = 0, naAgreeBefore = 0, naAgreeAfter = 0;
  for (const l of (logs ?? []) as Row[]) {
    const { data: ex } = await sb.from("ai_reply_examples").select("ai_draft, sent_reply, created_at").eq("conversation_id", l.conversation_id).eq("entry_source", "aix_action")
      .like("aix_action", "property_send%").gte("created_at", new Date(Date.parse(l.created_at) - 120_000).toISOString()).lte("created_at", new Date(Date.parse(l.created_at) + 120_000).toISOString()).limit(1);
    const pair = (ex ?? [])[0] as Row | undefined;
    if (!pair?.ai_draft) continue;
    const { data: hist } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", l.conversation_id)
      .lt("created_at", new Date(Date.parse(l.created_at) - 30_000).toISOString()).order("created_at", { ascending: false }).limit(25);
    const msgs = ((hist ?? []) as Row[]).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? "") }));
    const oldBlock = buildPropertySendThreadsBlock(extractPropertySendThreads(msgs));
    const oldEmpty = /無し → ③/.test(oldBlock);
    const now = readSendNow(msgs);
    const nowBlock = buildSendNowBlock(now);
    n++; if (oldEmpty) emptyBefore++; if (oldEmpty && !nowBlock) emptyAfter++;
    // スタッフが足した行の言葉が入力にあったか
    const dl = lines(pair.ai_draft).map(norm), added = lines(pair.sent_reply).filter((x) => !dl.includes(norm(x)));
    const g = added.flatMap(grams);
    if (g.length) {
      addedCases++;
      const inOld = g.some((x) => norm(oldBlock).replace(/[0-9０-９]+/g, "#").includes(x));
      const inNew = inOld || g.some((x) => norm(nowBlock).replace(/[0-9０-９]+/g, "#").includes(x));
      if (inOld) knownBefore++; if (inNew) knownAfter++;
    }
    if (l.send_mode === "new_arrival") {
      naN++;
      const staffNew = /新着|募集に(?:出|で)ました/.test(pair.sent_reply);
      if (staffNew) naAgreeBefore++;                                          // 前: いつも新着の言い方
      if (staffNew === (effectiveSendFrame("new_arrival", now) === "new_arrival")) naAgreeAfter++;
    }
  }
  console.log(`=== 会話を合わせる・物件ピックアップ（${DAYS}日・組 ${n}）===`);
  console.log(`① 最新のやり取りが生成に1つも届かない回: 前 ${emptyBefore}/${n} → 後 ${emptyAfter}/${n}`);
  console.log(`② スタッフが足した行の言葉が入力にあった回（AI が知り得た）: 前 ${knownBefore}/${addedCases} → 後 ${knownAfter}/${addedCases}`);
  console.log(`③ 送り方が新着の回（${naN}）で新着の言い方を使うかの一致: 前 ${naAgreeBefore}/${naN} → 後 ${naAgreeAfter}/${naN}`);
})().catch((e) => { console.error(e); process.exit(1); });
