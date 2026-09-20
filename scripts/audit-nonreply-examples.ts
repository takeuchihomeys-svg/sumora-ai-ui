// お客様宛てではない AIX の出力が「手本」に混ざっていないか（読み取りのみ）
//
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
// audit-callable-name.ts で「ゆそひさんのご案内をしております！！…ご確認をお願いできますでしょうか！！」
// という**管理会社宛て**の文が ai_draft に5件あった。出所は AIX【管理会社へ確認】で、
// route.ts のプロンプトに「【メッセージの宛先】管理会社またはオーナー（お客様宛てではない）」と明記された正しい機能。
// 問題は**その出力が手本 ai_reply_examples に入る**こと。手本は次の生成の材料になるので、
// お客様への返信に管理会社向けの言い回しが出る入口になる（設計知見「入口は厳しく」）。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** お客様宛てではない文の印（管理会社・オーナー向け） */
const TO_MGMT_RE = /のご案内をしております|ご確認をお願いできますでしょうか|お伺いできますでしょうか|現在も募集中でしょうか|御見積もりもお願いできますでしょうか/;

async function main() {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 16; p++) {
    const { data } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, ai_draft, sent_reply, aix_action, entry_source, was_ai_used, is_starred, created_at, conversation_state")
      .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  console.log(`=== 手本 ${rows.length}件 ===\n`);

  const hitDraft = rows.filter((r) => TO_MGMT_RE.test(String(r.ai_draft ?? "")));
  const hitSent = rows.filter((r) => TO_MGMT_RE.test(String(r.sent_reply ?? "")));
  console.log(`管理会社宛ての言い回しを含む: ai_draft ${hitDraft.length}件 / sent_reply ${hitSent.length}件\n`);
  for (const r of [...hitDraft, ...hitSent].slice(0, 12)) {
    console.log(`[${String(r.created_at).slice(5, 16)}] aix_action=${r.aix_action ?? "なし"} entry_source=${r.entry_source} state=${r.conversation_state} used=${r.was_ai_used} starred=${r.is_starred}`);
    console.log(`   draft: ${String(r.ai_draft ?? "").replace(/\n/g, " ").slice(0, 100)}`);
    console.log(`   sent : ${String(r.sent_reply ?? "").replace(/\n/g, " ").slice(0, 100)}`);
  }

  // どの aix_action が手本に入っているか（お客様宛てでない種類が混ざっていないか）
  const byAction = new Map<string, number>();
  for (const r of rows) {
    const a = String(r.aix_action ?? "（なし＝通常返信）");
    byAction.set(a, (byAction.get(a) ?? 0) + 1);
  }
  console.log(`\n=== 手本に入っている AIX の種類 ===`);
  for (const [a, n] of [...byAction.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(5)}件  ${a}`);
  }

  // 「お客様本日…」「お客様確認させて…」の出所
  for (const [label, re] of [["お客様本日", /お客様本日/], ["お客様確認させて", /お客様確認させて/]] as Array<[string, RegExp]>) {
    const h = rows.filter((r) => re.test(String(r.ai_draft ?? "")));
    console.log(`\n=== 「${label}」を含む下書き ${h.length}件 ===`);
    for (const r of h.slice(0, 6)) {
      console.log(`  [${String(r.created_at).slice(5, 16)}] aix_action=${r.aix_action ?? "なし"} state=${r.conversation_state} used=${r.was_ai_used}`);
      console.log(`     ${String(r.ai_draft ?? "").replace(/\n/g, " ").slice(0, 96)}`);
      console.log(`     正解: ${String(r.sent_reply ?? "").replace(/\n/g, " ").slice(0, 96)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
