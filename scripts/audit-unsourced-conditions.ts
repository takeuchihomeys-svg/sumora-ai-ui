// scripts/audit-unsourced-conditions.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-unsourced-conditions.ts
//
// 2026-09-19 竹内（慶次事例）「お客さんの条件ちゃんと読み取れているのか？別のお客さんの情報が入ってしまったのでは」
// 下書きに書かれた**条件語**（ペット可・駐車場・オートロック…）が、その会話のお客様の発言・登録条件に
// 根拠があるかを実データで数える。線を引く前に「実送信では根拠があるのが当たり前か」を確かめる。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** お客様が言う種類の条件語（こちらが初めて書く物件名とは違う） */
const COND_WORDS = ["ペット", "駐車場", "オートロック", "独立洗面", "バストイレ別", "宅配ボックス", "ウォークインクローゼット", "楽器", "事務所", "二人入居", "ルームシェア", "喫煙", "分譲", "角部屋"];

async function main() {
  // 実送信（スタッフが送った文）に条件語が出る時、その会話のお客様の発言に同じ語があるか
  console.log("=== 実送信で条件語を書いた時、お客様の発言に根拠があるか（365日）===");
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();

  for (const w of COND_WORDS) {
    const { data: sent } = await sb.from("messages")
      .select("conversation_id, text, created_at")
      .neq("sender", "customer").gte("created_at", since).ilike("text", `%${w}%`).limit(60);
    if (!sent?.length) continue;
    // 会話ごとにまとめて、その会話のお客様の発言に同じ語があるか
    const convIds = [...new Set(sent.map((s) => s.conversation_id as string))];
    let grounded = 0;
    for (const id of convIds) {
      const { count } = await sb.from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", id).eq("sender", "customer").ilike("text", `%${w}%`);
      if ((count ?? 0) > 0) grounded++;
    }
    const pct = (100 * grounded) / Math.max(convIds.length, 1);
    console.log(`  ${w.padEnd(14)} 送信のある会話 ${String(convIds.length).padStart(3)}件 / お客様も言っている ${String(grounded).padStart(3)}件 （${pct.toFixed(0)}%）`);
  }

  // 参考: AI下書き側で同じことを見る（根拠なしが混ざっていないか）
  console.log("\n=== AI下書き（conversations.ai_draft）で条件語を書いている会話 ===");
  for (const w of ["ペット", "駐車場", "オートロック"]) {
    const { data: drafts } = await sb.from("conversations")
      .select("id, customer_name, ai_draft").ilike("ai_draft", `%${w}%`).limit(30);
    if (!drafts?.length) { console.log(`  ${w}: 0件`); continue; }
    let grounded = 0; const bad: string[] = [];
    for (const d of drafts) {
      const { count } = await sb.from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", d.id as string).eq("sender", "customer").ilike("text", `%${w}%`);
      if ((count ?? 0) > 0) grounded++; else bad.push(`${d.customer_name}: ${String(d.ai_draft ?? "").replace(/\n/g, " / ").slice(0, 80)}`);
    }
    console.log(`  ${w}: 下書き ${drafts.length}件 / お客様も言っている ${grounded}件 / **根拠なし ${bad.length}件**`);
    bad.slice(0, 6).forEach((b) => console.log(`      ✗ ${b}`));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
