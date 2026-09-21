// 「お申込みいただきありがとうございます」を書いた1件の材料を全部出す（読み取りのみ）
//
// 2026-09-21 竹内「これ状況を読み取れていないから、ブレインのどこかに弱い部分がある」
//
// ここまでで分かったこと（scripts/audit-apply-thanks.ts）:
//   ・お礼形は実送信 **0通 / 6,816通** ＝ スタッフは一度も使わない
//   ・AI が書いたのは **1件だけ**（竹内さんのスクショの件）
//   ・手本（ai_reply_examples）にお礼形は **0件** ＝ few-shot の汚染ではない
//   → 出所は「手本」ではない。材料（ブレインの判断・場面の読み）を全部出して確かめる。
//
// 実行: npx tsx --env-file=.env.local scripts/peek-apply-thanks-context.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");
const APPLY_THANKS_RE = /お?申込(?:み|)(?:いただき|頂き|下さり|くださり)?(?:誠に)?ありがとう/;

async function main() {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, customer_message, ai_draft, sent_reply, aix_action, entry_source, reply_context_snapshot, conversation_state, customer_intent, outcome_status, created_at")
      .gte("created_at", new Date(Date.now() - 400 * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  const hits = out.filter((r) => APPLY_THANKS_RE.test(String(r.ai_draft ?? "")));
  console.log(`=== AI がお礼形を書いた ${hits.length}件 ===\n`);

  for (const r of hits) {
    console.log(`${"═".repeat(78)}`);
    console.log(`${String(r.created_at).slice(0, 16)}  action=${r.aix_action ?? "-"}  source=${r.entry_source ?? "-"}`);
    console.log(`お客様: ${mask(String(r.customer_message ?? ""))}`);
    console.log(`AI    : ${mask(String(r.ai_draft ?? "")).replace(/\n/g, " ／ ")}`);
    console.log(`実送信 : ${mask(String(r.sent_reply ?? "")).replace(/\n/g, " ／ ")}`);

    console.log(`\n── 生成時の材料（reply_context_snapshot の全キー）──`);
    const rc = (r.reply_context_snapshot ?? {}) as Record<string, unknown>;
    if (Object.keys(rc).length === 0) console.log(`   （空）`);
    for (const k of Object.keys(rc)) {
      const v = rc[k];
      const s = typeof v === "string" ? mask(v) : JSON.stringify(v);
      console.log(`   ${k}: ${String(s).slice(0, 220)}`);
    }

    console.log(`\n── 保存時の状態 ──`);
    console.log(`   conversation_state=${r.conversation_state ?? "-"}  customer_intent=${r.customer_intent ?? "-"}  outcome=${r.outcome_status ?? "-"}`);

    // その会話のブレインの判断
    if (r.conversation_id) {
      const { data: c } = await sb.from("conversations")
        .select("status, suggested_next_aix, suggested_aix_meta").eq("id", r.conversation_id).maybeSingle();
      const conv = (c ?? {}) as Record<string, unknown>;
      console.log(`\n── ブレインの判断（今の値）──`);
      console.log(`   status=${conv.status}  次のAIX=${conv.suggested_next_aix ?? "-"}`);
      const meta = (conv.suggested_aix_meta ?? {}) as Record<string, unknown>;
      for (const k of ["reply_direction", "reply_mode", "key_topics", "avoid_topics", "closing_strategy", "checkpoint_stage", "engagement_stance", "purchase_signal_level", "reply_opener"]) {
        const v = meta[k];
        if (v !== undefined && v !== null) console.log(`   ${k}: ${typeof v === "string" ? mask(v).slice(0, 200) : JSON.stringify(v).slice(0, 200)}`);
      }
      const led = (meta.action_ledger ?? {}) as Record<string, unknown>;
      if (Object.keys(led).length) console.log(`   action_ledger: ${JSON.stringify(led).slice(0, 400)}`);
    }
    console.log("");
  }

  // ナレッジに同じ形が入っていないか
  console.log(`${"═".repeat(78)}`);
  console.log(`=== ナレッジ（ai_reply_knowledge）にお礼形が入っていないか ===`);
  const knowledge: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data: kn, error: kerr } = await sb.from("ai_reply_knowledge")
      .select("id, category, content, used_count, apply_count, wrong_count").range(p * 1000, p * 1000 + 999);
    if (kerr) { console.log(`⚠ ${kerr.message}`); break; }
    const kr = (kn ?? []) as Array<Record<string, unknown>>;
    if (kr.length === 0) break; knowledge.push(...kr); if (kr.length < 1000) break;
  }
  const knHit = knowledge.filter((k) => APPLY_THANKS_RE.test(String(k.content ?? "")));
  console.log(`   ナレッジ ${knowledge.length}件 中 ${knHit.length}件`);
  for (const k of knHit.slice(0, 10)) {
    console.log(`   [${k.category}] used=${k.used_count} apply=${k.apply_count} wrong=${k.wrong_count}`);
    console.log(`     ${mask(String(k.content)).replace(/\n/g, " ／ ").slice(0, 160)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
