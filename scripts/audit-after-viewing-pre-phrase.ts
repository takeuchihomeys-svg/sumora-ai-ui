// 内覧が終わった後（こちらが内覧後のお礼を送った後）の下書きに「内覧前の文」が出ていた件数（読み取りのみ）
//
// 2026-09-21 竹内（まりあさん事例）「明日会えるの楽しみ等今の分からない文」
//   原因: 行動台帳が待ち合わせを日付だけで見て、内覧後も当日中は「この内覧は決まっている」と渡していた。
//   ここでは「内覧後のお礼の後」に作られた下書きのうち、内覧前の文が入った物を数え、実送信と並べる。
// 実行: npx tsx --env-file=.env.local scripts/audit-after-viewing-pre-phrase.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
import { STAFF_VIEWING_DONE_RE } from "../app/lib/viewing-thread";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").split("=")[1]);
const PRE_VIEWING_RE = /お会い(?:出来る|できる)のを楽しみ|お気をつけてお越し|明日[^\n]{0,10}(?:お会い|ご案内)/;
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Array<{ conversation_id: string; ai_draft: string | null; sent_reply: string | null; created_at: string }> = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, created_at")
      .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  const hits = rows.filter((r) => r.conversation_id && PRE_VIEWING_RE.test(r.ai_draft ?? ""));
  console.log(`=== 直近${DAYS}日 下書き ${rows.filter((r) => r.ai_draft).length}件のうち内覧前の文を含む ${hits.length}件 ===`);
  let afterThanks = 0, sentSame = 0;
  for (const h of hits) {
    // その下書きより前の12時間に、こちらの内覧後のお礼があるか
    const { data: prev } = await sb.from("messages").select("text, created_at").eq("conversation_id", h.conversation_id).eq("sender", "staff")
      .lt("created_at", h.created_at).gte("created_at", new Date(Date.parse(h.created_at) - 12 * 3600_000).toISOString());
    const thanked = ((prev ?? []) as Array<{ text: string | null }>).some((m) => STAFF_VIEWING_DONE_RE.test((m.text ?? "").normalize("NFKC")));
    if (!thanked) continue;
    afterThanks++;
    const sentHas = PRE_VIEWING_RE.test(h.sent_reply ?? "");
    if (sentHas) sentSame++;
    console.log(`\n${h.created_at.slice(0, 16)}`);
    console.log(`  下書き: ${mask(String(h.ai_draft)).replace(/\n/g, " ／ ").slice(0, 110)}`);
    console.log(`  実送信: ${mask(String(h.sent_reply ?? "（なし）")).replace(/\n/g, " ／ ").slice(0, 110)}`);
  }
  console.log(`\n内覧後のお礼の後に内覧前の文を書いた下書き: ${afterThanks}件（うち実送信でも同じ形 ${sentSame}件）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
