// 家賃交渉の「していない約束」を落とす関数の全件監査（読み取りのみ）
//
// 2026-09-23 竹内「家賃交渉は基本できないものだからいれない。この言い回しいれないようにする」
//
// 設計知見の型 ③実送信で線を引く ④誤削除0 ⑦全件監査（目で読む）に従う。
//   実送信（365日・スタッフ送信）に isRentNegotiationPromise を当てて **1通でも当たれば誤削除** なので、
//   候補は全部そのまま表示して目で読む（件数だけ見ない）。
//   AI下書き（ai_reply_examples）にも当てて、落ちる文とスタッフが実際に送った文を並べる。
//   ブレインの方向（brain_decision_logs.digest.dir）にも当てて、入口で何が落ちるかを変換の前後で読む。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-negotiation.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { isRentNegotiationPromise, stripRentNegotiation } from "../app/lib/rent-negotiation-guard";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 365);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

/** 家賃＋交渉語を含む候補（目で読む対象を作るためだけ。判定そのものは純関数に任せる） */
const CANDIDATE_RE = /(家賃|賃料)[^\n]{0,20}(値下げ|値引き|減額|交渉|安く)/;
const sentences = (t: string) => t.split(/[\n。！!？?]/).map((s) => s.trim()).filter(Boolean);

async function pageAll<T>(run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await run(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${error.message}`); break; }
    const r = (data ?? []) as T[];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 家賃交渉ガードの全件監査（直近${DAYS}日）===\n`);

  // ── ① 実送信（誤削除0の確認）──
  const sent = await pageAll<{ text: string | null }>((a, b) =>
    sb.from("messages").select("text").eq("sender", "staff").gte("created_at", since)
      .order("created_at", { ascending: false }).range(a, b));
  const sentTexts = sent.map((r) => String(r.text ?? "")).filter((t) => t && t !== "__SHOWN__");
  const sentCandidates = sentTexts.filter((t) => CANDIDATE_RE.test(t));
  const sentHits: string[] = [];
  for (const t of sentCandidates) for (const s of sentences(t)) if (isRentNegotiationPromise(s)) sentHits.push(s);

  console.log(`① 実送信 ${sentTexts.length}通 ／ 家賃＋交渉語の候補 ${sentCandidates.length}通`);
  console.log(`   → ガードが当たった（＝誤削除になる）: ${sentHits.length}通\n`);
  console.log("   [候補を全部目で読む]");
  for (const t of sentCandidates) {
    const hit = sentences(t).some(isRentNegotiationPromise);
    console.log(`   ${hit ? "❌落ちる" : "✅残る "} ${t.replace(/\n/g, " ").slice(0, 110)}`);
  }
  if (sentHits.length > 0) {
    console.log("\n   ⚠ 誤削除が0でない。入れる前に判定を狭めること:");
    for (const s of sentHits) console.log(`     - ${s.slice(0, 90)}`);
  }

  // ── ② AI下書き（何が落ちるか・スタッフの実送信と並べる）──
  const drafts = await pageAll<{ ai_draft: string | null; sent_reply: string | null; created_at: string }>((a, b) =>
    sb.from("ai_reply_examples").select("ai_draft, sent_reply, created_at").gte("created_at", since)
      .order("created_at", { ascending: false }).range(a, b));
  const draftHits = drafts.filter((d) => sentences(String(d.ai_draft ?? "")).some(isRentNegotiationPromise));
  console.log(`\n② AI下書き ${drafts.length}件 → 当たる ${draftHits.length}件（変換の前後を目で読む）`);
  for (const d of draftHits) {
    console.log(`\n   [${String(d.created_at).slice(0, 10)}]`);
    console.log(`   下書き  : ${String(d.ai_draft ?? "").replace(/\n/g, " ").slice(0, 150)}`);
    console.log(`   実送信  : ${String(d.sent_reply ?? "（削除・未送信）").replace(/\n/g, " ").slice(0, 150)}`);
    console.log(`   落ちる文: ${sentences(String(d.ai_draft ?? "")).filter(isRentNegotiationPromise).join(" / ").slice(0, 150)}`);
  }

  // ── ③ ブレインの方向（本当の出所・入口）──
  const logs = await pageAll<{ digest: { dir?: string | null } | null; created_at: string }>((a, b) =>
    sb.from("brain_decision_logs").select("digest, created_at").gte("created_at", since)
      .not("digest", "is", null).order("created_at", { ascending: false }).range(a, b));
  const dirs = logs.map((r) => ({ dir: String(r.digest?.dir ?? ""), at: r.created_at })).filter((x) => x.dir);
  const dirHits = dirs.filter((x) => stripRentNegotiation(x.dir).dropped);
  console.log(`\n③ ブレインの返信の方向 ${dirs.length}件 → 当たる ${dirHits.length}件（入口で落とす対象）`);
  for (const x of dirHits.slice(0, 80)) {
    const r = stripRentNegotiation(x.dir);
    console.log(`\n   [${String(x.at).slice(0, 10)}]`);
    console.log(`   前: ${x.dir}`);
    console.log(`   後: ${r.text ?? "（方向なし＝avoid_topics「家賃交渉」で本文を守る）"}`);
  }

  console.log(`\n=== まとめ ===`);
  console.log(`実送信の誤削除: ${sentHits.length}通（0でなければ入れない）`);
  console.log(`AI下書きで落ちる: ${draftHits.length}件 ／ ブレインの方向で落ちる: ${dirHits.length}件`);
}

main().catch((e) => { console.error(e); process.exit(1); });
