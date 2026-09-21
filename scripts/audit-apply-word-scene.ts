// 「申込」の語が、申込の場面でないのに出ていないか（読み取りのみ）
//
// 2026-09-21 竹内「お申込みと間違って受け取ってしまったのもこれが原因なのかな？
//   申込ではない場面で申込とか出るのは防ぐ必要あるから。ブレインはそこらの意味ちゃんと理解しているのか？」
//
// ■ ここまでで分かった因果
//   ① TPO が「ネガ文脈」と誤判定（→ app/lib/negative-context.ts で直した）
//   ② **セル ES_THINKING のラベル・direction に「申込」の語がある**:
//        direction  : 「次工程（内覧／申込）の開放1文」
//        mustInclude: 「次工程の開放（内覧／**申込**／不明点）」
//        mustNot    : 「**申込**催促・希少性煽り」      ← 同じセルで書くなとも言っている
//        example    : 「…実際にお部屋ご案内させて頂きますので…」← 実際の文に「申込」は無い
//   ③ ブレインは avoid_topics に「申込誘導」を入れていた（＝**正しく理解していた**）
//      なのに ①で指示が乗っ取られ、②のラベルの「申込」だけが残った。
//
// ■ ここで測ること
//   検討中・了承の場面で、スタッフの実送信に「申込」の語が何通あるか。
//   少なければセルのラベルから「申込」を外してよい（実送信で線を引く）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-word-scene.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 365);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

/** 「申込」の語（どんな形でも） */
const APPLY_WORD_RE = /申(?:し)?込/;
/** お客様が検討中・了承を返した形 */
const CUSTOMER_THINKING_RE = /検討し|考え(?:ます|てみ)|相談し|持ち帰|見てみ|確認し(?:ます|てみ)|拝見/;
const CUSTOMER_ACK_RE = /^(?:はい|ありがとう|了解|承知|わかりました|分かりました)/;

async function page(days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, customer_message, ai_draft, sent_reply, aix_action, reply_context_snapshot, created_at")
      .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const rows = await page(DAYS);
  const sent = rows.filter((r) => String(r.sent_reply ?? "").trim());
  console.log(`=== 直近${DAYS}日 実送信 ${sent.length}通 ===\n`);

  // ① セル（ruleId）ごとに「申込」の語が出る率
  type Snap = { turnPair?: { ruleId?: string | null } | null };
  const withRule = sent.filter((r) => (r.reply_context_snapshot as Snap)?.turnPair?.ruleId);
  const byRule = new Map<string, { n: number; apply: number }>();
  for (const r of withRule) {
    const id = String((r.reply_context_snapshot as Snap).turnPair!.ruleId);
    const c = byRule.get(id) ?? { n: 0, apply: 0 };
    c.n++;
    if (APPLY_WORD_RE.test(String(r.sent_reply))) c.apply++;
    byRule.set(id, c);
  }
  console.log(`=== ① セルごとに「申込」の語が実送信に出る率（材料が残る ${withRule.length}通）===`);
  console.log(`   セル                 通数   「申込」あり`);
  for (const [id, c] of [...byRule.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const mark = id.includes("THINKING") ? "  ← 検討中の場面" : "";
    console.log(`   ${id.padEnd(20)} ${String(c.n).padStart(4)}  ${String(c.apply).padStart(4)}件（${pct(c.apply, c.n).padStart(6)}）${mark}`);
  }

  // ② 材料が無い分も含めて、お客様が「検討します」と言った通で測る（母数を増やす）
  const thinking = sent.filter((r) => CUSTOMER_THINKING_RE.test(String(r.customer_message ?? "")));
  const thinkingApply = thinking.filter((r) => APPLY_WORD_RE.test(String(r.sent_reply)));
  console.log(`\n=== ② お客様が「検討します／確認します」と言った通 ${thinking.length}通 ===`);
  console.log(`   返信に「申込」の語がある: **${thinkingApply.length}通（${pct(thinkingApply.length, thinking.length)}）**`);
  console.log(`\n   ─ 「申込」を使っている実送信（どう使っているか）─`);
  for (const r of thinkingApply.slice(0, 12)) {
    const line = String(r.sent_reply).split("\n").find((l) => APPLY_WORD_RE.test(l)) ?? "";
    console.log(`   お客様「${mask(String(r.customer_message ?? "")).slice(0, 26)}」`);
    console.log(`      → ${mask(line.trim()).slice(0, 96)}`);
  }

  // ③ その「申込」は依頼（これから）か、お礼（済んだこと）か
  const APPLY_THANKS_RE = /お?申込(?:み|)(?:いただき|頂き|下さり|くださり)?(?:誠に)?ありがとう/;
  const thanks = thinkingApply.filter((r) => APPLY_THANKS_RE.test(String(r.sent_reply)));
  console.log(`\n=== ③ そのうち「済んだことへのお礼」の形 ===`);
  console.log(`   **${thanks.length}通** ← 0 なら「検討中に申込のお礼」はスタッフが一度もしない`);

  // ④ AI の下書きと実送信で「申込」の出方が違うか（AI が書きすぎているか）
  const pairs = rows.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim()
    && CUSTOMER_THINKING_RE.test(String(r.customer_message ?? "")));
  const draftApply = pairs.filter((r) => APPLY_WORD_RE.test(String(r.ai_draft)));
  const keptApply = draftApply.filter((r) => APPLY_WORD_RE.test(String(r.sent_reply))).length;
  const addedApply = pairs.filter((r) => !APPLY_WORD_RE.test(String(r.ai_draft)) && APPLY_WORD_RE.test(String(r.sent_reply))).length;
  console.log(`\n=== ④ 検討中の場面で AI が「申込」を書いた時、スタッフはどうしたか ===`);
  console.log(`   下書きと実送信が揃う ${pairs.length}通`);
  console.log(`   AI が「申込」を書いた ${draftApply.length}通 ／ 残した ${keptApply}通 ／ **消した ${draftApply.length - keptApply}通**`);
  console.log(`   AI が書かなかったのにスタッフが**足した** ${addedApply}通`);
  for (const r of draftApply.filter((x) => !APPLY_WORD_RE.test(String(x.sent_reply))).slice(0, 6)) {
    console.log(`\n   お客様「${mask(String(r.customer_message ?? "")).slice(0, 30)}」`);
    console.log(`      AI    : ${mask(String(r.ai_draft)).replace(/\n/g, " ／ ").slice(0, 90)}`);
    console.log(`      実送信 : ${mask(String(r.sent_reply)).replace(/\n/g, " ／ ").slice(0, 90)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
