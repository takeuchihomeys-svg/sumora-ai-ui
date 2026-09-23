// 2026-09-23 場面ギャップ（S1〜S8）の「線」を実送信で引き直す監査（読み取りのみ・LLM 呼び出し 0）
//
// 設計知見の型 ③実送信で線を引く ④誤削除0 ⑦全件監査（目で読む）。
// 入口・出口に入れる前に、ここで候補を**全部そのまま表示して目で読む**（件数だけ見ない）。
//
//   A. クレジットカード払い: 実送信（365日）の全通を表示 → company-facts に足してよいか（3通一致か・反する断定0か）
//   B. 「管理会社・オーナー・貸主に（割引|値引き|条件）を交渉/相談/確認します」: 実送信 365日で 0 か（誤削除0）
//      ＋ AI 下書き（ai_reply_examples.ai_draft）で何が落ちるか（変換の前後を読む）
//   C. 末尾の孤立した「」」: 実送信 365日で 0 か（出口で落とすための誤削除0）
//   D. 本文1行目がお客様の直近発言と完全一致: 今月の実送信で 0 か
//   E. [画像] の書き起こしの形（company-facts のゲートから外すために、テキストの形を確認）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-s9-gap-lines.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { isMgmtDiscountNegotiationPromise } from "../app/lib/rent-negotiation-guard";
import { stripOrphanClosingQuote } from "../app/lib/draft-text";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 365);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const monthStart = "2026-09-01T00:00:00+09:00";

const sentences = (t: string) => t.split(/[\n。！!？?]/).map((s) => s.trim()).filter(Boolean);
const one = (t: string, n = 140) => t.replace(/\n/g, "␤").slice(0, n);

async function pageAll<T>(run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await run(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${error.message}`); break; }
    const r = (data ?? []) as T[];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };

async function main() {
  console.log(`=== S1〜S8 ギャップの線の引き直し（直近${DAYS}日・読み取りのみ）===\n`);
  const staff = await pageAll<Msg>((a, b) =>
    sb.from("messages").select("conversation_id, sender, text, created_at").eq("sender", "staff").gte("created_at", since)
      .order("created_at", { ascending: false }).range(a, b));
  const staffTexts = staff.map((r) => String(r.text ?? "")).filter((t) => t && t !== "__SHOWN__");
  console.log(`実送信（スタッフ）: ${staffTexts.length}通\n`);

  // ── A. クレジットカード払い ──
  const cardRe = /クレジット|クレカ|カード払|カード決済/;
  const cardSent = staffTexts.filter((t) => cardRe.test(t));
  console.log(`A. クレジットカード払いに触れた実送信: ${cardSent.length}通（全部読む）`);
  for (const t of cardSent) console.log(`   - ${one(t, 220)}`);
  const custMonth = await pageAll<Msg>((a, b) =>
    sb.from("messages").select("conversation_id, sender, text, created_at").eq("sender", "customer").gte("created_at", monthStart)
      .order("created_at", { ascending: false }).range(a, b));
  const cardAsk = custMonth.filter((m) => cardRe.test(String(m.text ?? "")) && !/^\s*\[画像\]/.test(String(m.text ?? "")));
  console.log(`   今月のお客様の質問: ${cardAsk.length}通`);
  for (const m of cardAsk) console.log(`   ? ${one(String(m.text ?? ""), 120)}`);

  // ── B. 管理会社への割引・条件交渉の予告 ──
  const mgmtCand = /(管理会社|オーナー|貸主|家主|先方|管理側)[^\n]{0,24}(割引|値引|値下げ|条件|交渉)/;
  const mgmtCands = staffTexts.filter((t) => mgmtCand.test(t));
  const mgmtHits: string[] = [];
  for (const t of mgmtCands) for (const s of sentences(t)) if (isMgmtDiscountNegotiationPromise(s)) mgmtHits.push(s);
  console.log(`\nB. 管理会社＋割引/条件/交渉の候補（実送信）: ${mgmtCands.length}通 → 純関数が当たる（＝誤削除）: ${mgmtHits.length}`);
  for (const t of mgmtCands) {
    const hit = sentences(t).some(isMgmtDiscountNegotiationPromise);
    console.log(`   ${hit ? "❌落ちる" : "✅残る "} ${one(t, 150)}`);
  }
  const feeCond = staffTexts.filter((t) => /(費用|条件)[・･、]?(条件)?交渉の可否/.test(t));
  console.log(`   「費用・条件交渉の可否」: ${feeCond.length}通`);
  const drafts = await pageAll<{ ai_draft: string | null; sent_reply: string | null; created_at: string }>((a, b) =>
    sb.from("ai_reply_examples").select("ai_draft, sent_reply, created_at").gte("created_at", since)
      .order("created_at", { ascending: false }).range(a, b));
  const draftHits = drafts.filter((d) => sentences(String(d.ai_draft ?? "")).some(isMgmtDiscountNegotiationPromise));
  console.log(`   AI下書き ${drafts.length}件 → 当たる ${draftHits.length}件（変換の前後）`);
  for (const d of draftHits) {
    console.log(`   [${String(d.created_at).slice(0, 10)}] 下書き: ${one(String(d.ai_draft ?? ""), 150)}`);
    console.log(`              実送信: ${one(String(d.sent_reply ?? "（削除・未送信）"), 150)}`);
  }

  // ── C. 末尾の孤立「」」 ──
  const orphan = staffTexts.filter((t) => stripOrphanClosingQuote(t) !== t);
  console.log(`\nC. 末尾の孤立した「」」（出口で落とすと変わる実送信）: ${orphan.length}通`);
  for (const t of orphan) console.log(`   - ${one(t, 150)}`);
  const draftOrphan = drafts.filter((d) => stripOrphanClosingQuote(String(d.ai_draft ?? "")) !== String(d.ai_draft ?? ""));
  console.log(`   AI下書きで変わる: ${draftOrphan.length}件`);
  for (const d of draftOrphan.slice(0, 15)) console.log(`   [${String(d.created_at).slice(0, 10)}] ${one(String(d.ai_draft ?? "").slice(-90), 100)}`);

  // ── D. 1行目がお客様の直近発言と完全一致（今月） ──
  const all = await pageAll<Msg>((a, b) =>
    sb.from("messages").select("conversation_id, sender, text, created_at").gte("created_at", monthStart)
      .order("created_at", { ascending: true }).range(a, b));
  const byConv = new Map<string, Msg[]>();
  for (const m of all) { const arr = byConv.get(m.conversation_id) ?? []; arr.push(m); byConv.set(m.conversation_id, arr); }
  let pairs = 0, echoHits = 0; const echoSamples: string[] = [];
  for (const arr of byConv.values()) {
    for (let i = 1; i < arr.length; i++) {
      const cur = arr[i], prev = arr[i - 1];
      if (cur.sender !== "staff" || prev.sender !== "customer") continue;
      const c = String(prev.text ?? "").trim(); const s = String(cur.text ?? "").trim();
      if (!c || !s || c.length < 6 || /^\[画像\]/.test(c)) continue;
      pairs++;
      const first = s.split("\n")[0].trim().replace(/^「|」$/g, "");
      if (first === c || first === c.split("\n")[0].trim()) { echoHits++; echoSamples.push(`${one(c, 60)} ⇒ ${one(s, 80)}`); }
    }
  }
  console.log(`\nD. 今月のお客様→スタッフの対 ${pairs} → 1行目がお客様の発言と完全一致: ${echoHits}`);
  for (const s of echoSamples.slice(0, 10)) console.log(`   - ${s}`);

  // ── E. [画像] の書き起こしの形 ──
  const imgTexts = custMonth.map((m) => String(m.text ?? "")).filter((t) => /^\s*\[画像\]/.test(t) && t.length > 12);
  console.log(`\nE. [画像] で始まり本文が続くお客様の発言（今月）: ${imgTexts.length}通。形のサンプル:`);
  for (const t of imgTexts.slice(0, 6)) console.log(`   - ${JSON.stringify(t.slice(0, 120))}`);
  const multi = imgTexts.filter((t) => t.includes("\n")).length;
  console.log(`   改行を含む: ${multi}／${imgTexts.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
