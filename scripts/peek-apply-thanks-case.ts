// 「お申込みいただきありがとうございます」が出た1通の出所を追う（読み取りのみ）
//
// 2026-09-21 竹内「なんでここでお申込頂きありがとうございますと意味のわからない文が生成されるのか。
//   これ状況を読み取れていないから、ブレインのどこかに弱い部分があるのでその部分を見つけて強化する必要がある。
//   今の状況把握して文をつくる部分。申込ありがとうございますって申込とは審査の申込みの時に使うものであって、
//   このような場面で使わないから、原因見つける。」
//
// 実物（スクショ・ギガ賃貸）:
//   16:52 こちら「〈お客様〉お待たせ致しました！！／こちらお部屋の詳細となります！！／
//               〈お客様〉お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！／お手隙の際にご査収ください😌！！」
//   16:53 お客様「ありがとうございます🙇 検討します」
//   16:55 下書き「はい！！／**お申込みいただきありがとうございます😊**／
//               お部屋お気に召されましたらお申込みでお部屋押さえさせて頂きます！！」
//   ＝ 申込は1件も入っていないのに「お申込みいただきありがとうございます」。
//
// 設計知見「おかしな文を1通見つけたら」の②出所を追う。候補は5つ:
//   ブレインの判断 / 手本 ai_reply_examples / ナレッジ ai_reply_knowledge / 行動台帳 / セーブデータ
//
// ⚠ 個人情報（本名）はマスキングする。
// 実行: npx tsx --env-file=.env.local scripts/peek-apply-thanks-case.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");
const APPLY_THANKS_RE = /お申込(?:み|)(?:いただき|頂き|ありがとう)/;

async function main() {
  // 下書きに「お申込みいただきありがとうございます」が入っている会話を新しい順に探す
  const { data: convs, error } = await sb.from("conversations")
    .select("id, customer_name, status, ai_draft, ai_draft_check, suggested_next_aix, suggested_aix_meta, last_sender, updated_at")
    .order("updated_at", { ascending: false })
    .limit(400);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = (convs ?? []) as Array<Record<string, unknown>>;
  const hit = rows.filter((r) => APPLY_THANKS_RE.test(String(r.ai_draft ?? "")));
  console.log(`=== 下書きに「お申込み…ありがとう」が入っている会話 ${hit.length}件 / 直近${rows.length}会話 ===\n`);

  for (const c of hit.slice(0, 3)) {
    console.log(`${"─".repeat(78)}`);
    console.log(`会話 ${String(c.id).slice(0, 8)}…  status=${c.status}  last_sender=${c.last_sender}`);
    console.log(`下書き:`);
    console.log(mask(String(c.ai_draft ?? "")).split("\n").map((l) => `   ${l}`).join("\n"));

    // ① ブレインの判断
    const meta = (c.suggested_aix_meta ?? {}) as Record<string, unknown>;
    console.log(`\n── ① ブレインの判断（suggested_aix_meta）──`);
    console.log(`   次のAIX: ${c.suggested_next_aix ?? "-"}`);
    for (const k of ["reply_direction", "reply_mode", "key_topics", "avoid_topics", "closing_strategy", "checkpoint_stage", "engagement_stance", "purchase_signal_level"]) {
      const v = meta[k];
      if (v !== undefined && v !== null) console.log(`   ${k}: ${typeof v === "string" ? mask(v).slice(0, 160) : JSON.stringify(v).slice(0, 160)}`);
    }
    const ledger = (meta.action_ledger ?? {}) as Record<string, unknown>;
    if (Object.keys(ledger).length) {
      console.log(`\n── ② 行動台帳（action_ledger）──`);
      console.log(`   ${JSON.stringify(ledger).slice(0, 600)}`);
    }

    // ③ 直近の会話
    const { data: msgs } = await sb.from("messages")
      .select("sender, text, created_at").eq("conversation_id", c.id)
      .order("created_at", { ascending: false }).limit(8);
    console.log(`\n── ③ 直近の会話（新しい順）──`);
    for (const m of ((msgs ?? []) as Array<Record<string, unknown>>)) {
      console.log(`   [${String(m.sender)}] ${mask(String(m.text ?? "")).replace(/\n/g, " ／ ").slice(0, 100)}`);
    }

    // ④ 生成時の材料（reply_context_snapshot）
    const { data: snap } = await sb.from("ai_reply_examples")
      .select("reply_context_snapshot, created_at").eq("conversation_id", c.id)
      .order("created_at", { ascending: false }).limit(1);
    const s = ((snap ?? [])[0] ?? {}) as Record<string, unknown>;
    if (s.reply_context_snapshot) {
      const rc = s.reply_context_snapshot as Record<string, unknown>;
      console.log(`\n── ④ 生成時の材料（reply_context_snapshot・最新）──`);
      for (const k of Object.keys(rc).slice(0, 20)) {
        const v = rc[k];
        console.log(`   ${k}: ${typeof v === "string" ? mask(v).slice(0, 120) : JSON.stringify(v).slice(0, 120)}`);
      }
    }
    console.log("");
  }

  // ⑤ そもそもこの言い回しは実送信に何通あるか（線を引く材料）
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data } = await sb.from("ai_reply_examples")
      .select("sent_reply, ai_draft, aix_action, created_at")
      .gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  const sent = out.filter((r) => String(r.sent_reply ?? "").trim());
  const sentHit = sent.filter((r) => APPLY_THANKS_RE.test(String(r.sent_reply)));
  const draftHit = out.filter((r) => APPLY_THANKS_RE.test(String(r.ai_draft ?? "")));
  console.log(`${"═".repeat(78)}`);
  console.log(`=== ⑤ 「お申込み…ありがとう」は実送信に何通あるか（直近365日）===`);
  console.log(`   実送信 ${sent.length}通 中 **${sentHit.length}通**（${sent.length ? (sentHit.length / sent.length * 100).toFixed(2) : "-"}%）`);
  console.log(`   AI の下書き ${out.length}件 中 **${draftHit.length}件**`);
  console.log(`\n   ─ 実送信で使われている文脈（最大10件）─`);
  for (const r of sentHit.slice(0, 10)) {
    console.log(`   [${r.aix_action ?? "-"}] ${mask(String(r.sent_reply)).replace(/\n/g, " ／ ").slice(0, 110)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
