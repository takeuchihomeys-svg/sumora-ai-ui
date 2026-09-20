// 内覧が既に決まっている時、スタッフは実際どう返しているか（読み取りのみ）
//
// 2026-09-20 竹内（まりあさん事例）: 行動台帳は「9/21 16:00 に決まっている。新しい内覧日程の打診
//   （『ご都合よろしいお日にち』『ご案内させて頂きます』）は書かない」と渡していたのに、
//   往復文脈セル ES_POSITIVE は「『ご都合よろしいお日にちにご案内させて頂きます』を1文入れる」を**必須**にしていた。
//   矛盾した2つの必須を受けた LLM が、どちらも避けて「お申込み情報受け取りました」を捏造した。
//
// ここで測るのは「内覧が決まっている時にスタッフが新規の内覧提案を書くか」。
// 書かないのが過半数なら、決まっている時は必須を外してよい（入口を直す＝安全）。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 新しく内覧の日程を打診する言い回し（ES_POSITIVE / PS_POSITIVE / CR_POSITIVE の fix・example の形） */
const NEW_OFFER_RE = /ご都合[^\n。！!]{0,10}(?:よろしい|の良い|のよい)?[^\n。！!]{0,6}お日にち|ご都合[^\n。！!]{0,8}(?:いかが|よろしい)(?:でしょうか|ですか)/;
/** 決まっている内覧を前提にした受け答え */
const FIXED_RE = /(?:明日|本日|当日|[0-9０-９]{1,2}[\/／月][0-9０-９]{1,2})[^\n]{0,14}(?:ご案内|お待ちし|よろしく)|お待ちしております|お気をつけてお越し/;

function jstDay(iso: string): string { return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10); }

async function main() {
  // ① 予定が入っている会話（今後・過去問わず scheduled_date を持つ）
  const { data: vh } = await sb.from("viewing_history")
    .select("conversation_id, scheduled_date, scheduled_time, status, created_at")
    .not("scheduled_date", "is", null)
    .order("created_at", { ascending: false })
    .limit(1200);
  const rows = (vh ?? []) as Array<{ conversation_id: string; scheduled_date: string; scheduled_time: string | null; status: string | null; created_at: string }>;
  console.log(`=== 予定のある内覧 ${rows.length}件 ===`);

  // 会話ごとに「最後に入った予定」
  const byConv = new Map<string, { date: string; setAt: string }>();
  for (const r of rows) {
    if (!r.conversation_id) continue;
    if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, { date: r.scheduled_date, setAt: r.created_at });
  }
  console.log(`  会話 ${byConv.size}件`);

  // ② その予定が入ってから予定日までの間のスタッフ返信を集める
  let win = 0, newOffer = 0, fixedStyle = 0;
  const offerSamples: string[] = [];
  const fixedSamples: string[] = [];
  const convs = [...byConv.entries()];
  for (let i = 0; i < convs.length; i += 40) {
    const chunk = convs.slice(i, i + 40);
    const { data: msgs } = await sb.from("messages")
      .select("conversation_id, text, created_at, sender")
      .in("conversation_id", chunk.map(([id]) => id))
      .eq("sender", "staff")
      .order("created_at", { ascending: true });
    for (const m of ((msgs ?? []) as Array<{ conversation_id: string; text: string | null; created_at: string }>)) {
      const v = byConv.get(m.conversation_id); if (!v || !m.text) continue;
      const d = jstDay(m.created_at);
      // 予定が入った後 〜 予定日当日まで＝「内覧が決まっている状態」
      if (m.created_at <= v.setAt) continue;
      if (d > v.date) continue;
      win++;
      if (NEW_OFFER_RE.test(m.text)) { newOffer++; if (offerSamples.length < 8) offerSamples.push(m.text.replace(/\n/g, " ").slice(0, 88)); }
      else if (FIXED_RE.test(m.text)) { fixedStyle++; if (fixedSamples.length < 8) fixedSamples.push(m.text.replace(/\n/g, " ").slice(0, 88)); }
    }
  }
  const pct = (n: number) => win ? `${((n / win) * 100).toFixed(1)}%` : "-";
  console.log(`\n=== 内覧が決まっている間のスタッフ返信 ${win}通 ===`);
  console.log(`  新しく日程を打診（「ご都合よろしいお日にち」型）: ${newOffer}通 ${pct(newOffer)}`);
  console.log(`  決まっている前提の受け答え               : ${fixedStyle}通 ${pct(fixedStyle)}`);
  console.log(`\n  --- 新規打診の実例 ---`);
  for (const s of offerSamples) console.log(`    ${s}`);
  console.log(`\n  --- 決まっている前提の実例 ---`);
  for (const s of fixedSamples) console.log(`    ${s}`);

  // ③ 「申込を受け取った」の捏造が下書きに他にもあるか
  const { data: drafts } = await sb.from("ai_reply_examples")
    .select("id, conversation_id, customer_message, ai_draft, sent_reply, was_ai_used, created_at")
    .not("ai_draft", "is", null)
    .order("created_at", { ascending: false })
    .limit(3000);
  const ds = (drafts ?? []) as Array<Record<string, unknown>>;
  const APPLY_CLAIM_RE = /お?申込(?:み)?(?:情報|書類|内容)?[^\n。！!]{0,10}(?:受け取り|受領|拝受|頂きました|いただきました|確かに)/;
  const bad = ds.filter((d) => APPLY_CLAIM_RE.test(String(d.ai_draft ?? "")));
  console.log(`\n=== 下書き ${ds.length}件 に「申込を受け取った」型: ${bad.length}件 ===`);
  for (const b of bad.slice(0, 12)) {
    console.log(`  [${String(b.created_at).slice(5, 16)} ai_used=${b.was_ai_used}] 客:「${String(b.customer_message ?? "").replace(/\n/g, " ").slice(0, 36)}」`);
    console.log(`      下書き: ${String(b.ai_draft ?? "").replace(/\n/g, " ").slice(0, 86)}`);
    console.log(`      実送信: ${String(b.sent_reply ?? "").replace(/\n/g, " ").slice(0, 86)}`);
  }

  // ④ 実送信で「申込を受け取った」が正当な場面は何通あるか（誤削除0の線引き用）
  const sentHits: string[] = [];
  for (let p = 0; p < 13; p++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("id", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null }>;
    if (r.length === 0) break;
    for (const x of r) if (x.text && APPLY_CLAIM_RE.test(x.text)) sentHits.push(x.text);
    if (r.length < 1000) break;
  }
  console.log(`\n=== 実送信に「申込を受け取った」型: ${sentHits.length}通 ===`);
  for (const s of sentHits.slice(0, 10)) console.log(`    ${s.replace(/\n/g, " ").slice(0, 96)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
