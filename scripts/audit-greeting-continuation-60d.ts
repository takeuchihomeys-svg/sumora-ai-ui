// scripts/audit-greeting-continuation-60d.ts — 竹内さん本人の番で「その日最初の会話文」の挨拶を、同じ日の続きの番／別の日に新しく来た番 に分けて数える（読むだけ・LLM なし）
//
// 2026-11-21 作業員L（統括役の確かめ: 確認事項 a56a67ab の推奨「続きの番は省く（実際の送り方に合わせる）」と、試験の正解（続きの番で翌日に返した8問のうち挨拶あり6）が食い違う）。
//   数える番: 竹内さん本人（staff_writer=takeuchi）の手打ちの会話文で、その JST の日のこちらの最初の会話文（資料文・画像は数えない）・直前がお客様の発言の番。初回（それまでにこちらの会話文なし）は外す。
//   分け: 続き＝お客様の束の頭が、こちらの前の会話文と同じ JST の日（greeting.continuedSameDay と同じ線）／別の日＝お客様の束の頭が前の会話文と別の日。
//   挨拶あり＝先頭2行に「お世話になっております」。重い読み（60日の messages）なので営業時間（JST 9〜22時）は止める。--force は手元の確かめだけ。
// 実行（22時以降）: npx tsx --env-file=.env.local scripts/audit-greeting-continuation-60d.ts [--days=60]
import { createClient } from "@supabase/supabase-js";
import { isMaterialOnlyText } from "../app/lib/daily-greeting";
import { NO_LINE_TEST_CONVERSATION_IDS, STAFF_INTERNAL_CONVERSATION_IDS, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const day = (iso: string) => new Date(Date.parse(iso) + 9 * 36e5).toISOString().slice(0, 10);
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
const isTalk = (m: M) => m.sender === "staff" && !!(m.text ?? "").trim() && !/^\[(?:画像|動画|スタンプ|ファイル)\]$/.test((m.text ?? "").trim()) && !isMaterialOnlyText(m.text ?? "");
(async () => {
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { console.log("営業時間なので止めた（22時以降に流す）"); return; }
  const days = Number(arg("days", "60")) || 60;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - (days + 2) * 864e5).toISOString();
  const skip = new Set<string>([YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS, ...STAFF_INTERNAL_CONVERSATION_IDS]);
  const { data: tk } = await sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").gte("created_at", since).limit(20000);
  const convs = [...new Set(((tk ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !skip.has(c));
  const tally = { cont: { n: 0, greet: 0 }, newday: { n: 0, greet: 0 } };
  const winStart = Date.now() - days * 864e5;
  for (const c of convs) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(3000);
    const ms = (data ?? []) as M[];
    let anyTalkBefore = false;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!isTalk(m)) continue;
      const firstTalk = anyTalkBefore;
      anyTalkBefore = true;
      if (!firstTalk) continue; // 初回は外す
      if (m.staff_writer !== "takeuchi" || m.is_aix_generated || Date.parse(m.created_at) < winStart) continue;
      if (!(i > 0 && ms[i - 1].sender === "customer")) continue;
      // その日の最初の会話文か
      const d = day(m.created_at);
      if (ms.slice(0, i).some((x) => isTalk(x) && day(x.created_at) === d)) continue;
      // お客様の束の頭と、その前のこちらの会話文
      let hI = i - 1; while (hI > 0 && ms[hI - 1].sender === "customer") hI--;
      let k = hI - 1; while (k >= 0 && !isTalk(ms[k]) && ms[k].sender !== "customer") k--;
      const prev = k >= 0 && ms[k].sender !== "customer" ? ms[k] : null;
      if (!prev) continue;
      const cont = day(prev.created_at) === day(ms[hI].created_at);
      const greet = /お世話になっております/.test((m.text ?? "").split("\n").slice(0, 2).join("\n"));
      const t = cont ? tally.cont : tally.newday; t.n++; if (greet) t.greet++;
    }
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  console.log(`竹内さん本人の「その日最初の会話文」（${days}日・会話 ${convs.length}・初回は外す）`);
  console.log(`同じ日の続きの番（翌日以降に返した）: ${tally.cont.n}番・挨拶あり ${tally.cont.greet}（${pct(tally.cont.greet, tally.cont.n)}）`);
  console.log(`別の日に新しく来た番: ${tally.newday.n}番・挨拶あり ${tally.newday.greet}（${pct(tally.newday.greet, tally.newday.n)}）`);
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
