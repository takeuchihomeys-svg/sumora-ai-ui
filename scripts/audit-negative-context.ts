// 「ネガ文脈（否決・募集終了報告）」の判定が正しいか（読み取りのみ）
//
// 2026-09-21 竹内「なんでここでお申込頂きありがとうございますと意味のわからない文が生成されるのか。
//   これ状況を読み取れていないから、ブレインのどこかに弱い部分がある」
//
// ■ 追った結果（scripts/peek-apply-thanks-context.ts）
//   ブレインもセル（ES_THINKING）も turnPair も**正しく「検討中」と読んでいた**のに、
//   TPO だけが「ネガ文脈（否決・募集終了報告への短い了承）」になっていて、
//   本文の指示（effectiveReplyDirection）を丸ごと乗っ取っていた:
//     tpo_label: ネガ文脈（否決・募集終了報告への短い了承。開口語「はい！！」→サポート継続宣言→次の一手1文）
//     negativeKind: staff_report ／ isNegativeContext: true
//   会話は「物件の詳細＋見積書を送った → お客様『ありがとうございます🙇 検討します』」で、
//   否決も募集終了も1つも無い。
//
// ■ 疑っている所（generate-reply/route.ts 3892 付近）
//   return (aixSaysUnavailable || staffSaysNeg || brainCorroborates) ? { kind: "staff_report" } : none;
//   の brainCorroborates は **コメントに「ブレイン由来は補助証拠のみ」と書いてある**のに
//   `||` で単独でも確定してしまう:
//     brainFresh && stance==="wait" && customer_intent==="negative"
//   ＝ スタッフが否決を報告していなくても、ブレインが「待ち」かつ「懸念あり」と言えばネガ文脈になる。
//
// ■ ここで測ること
//   ① ネガ文脈になった通が何件あるか
//   ② そのうち**直前のスタッフ送信に否決・募集終了の語が無い**もの（＝ブレイン単独で立った疑い）が何件か
//   ③ その通をスタッフが直したか（＝誤判定なら直されているはず）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-negative-context.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 120);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

/** ⚠ route.ts の staffNegResultRe と同じ形にすること（四者同名） */
const STAFF_NEG_RESULT_RE = /否決|不承認|募集終了(?:でした|となって|しており|していました|とのこと|です)|埋まって(?:しまい|おり|いました|しまって)|満室(?:でした|となって|とのこと)|先約|他の方で決まり|申込が入って(?:しまい|おり)|審査.{0,8}(?:通らな|通りません|落ち|NG|見送り|承認が(?:下り|おり)ません|難しい)(?:かった|でした|ました|となり|とのこと|になり|と)/;

async function page(days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, customer_message, ai_draft, sent_reply, reply_context_snapshot, created_at")
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
  const withSnap = rows.filter((r) => r.reply_context_snapshot && Object.keys(r.reply_context_snapshot as object).length > 0);
  console.log(`=== 直近${DAYS}日 ${rows.length}件（材料が残っている ${withSnap.length}件）===\n`);

  type Snap = { isNegativeContext?: boolean; negativeKind?: string | null; lastStaffMsgHead?: string | null; tpo_label?: string | null; isThinkingMsg?: boolean; substance?: { waitSignal?: { yes?: boolean } } };
  const neg = withSnap.filter((r) => (r.reply_context_snapshot as Snap).isNegativeContext === true);
  console.log(`=== ① ネガ文脈になった通 ${neg.length}件（${pct(neg.length, withSnap.length)}）===`);
  const byKind = new Map<string, number>();
  for (const r of neg) {
    const k = String((r.reply_context_snapshot as Snap).negativeKind ?? "-");
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(14)} ${n}件`);

  // ② staff_report のうち、直前のスタッフ送信に否決・募集終了の語が**無い**もの
  const staffReport = neg.filter((r) => String((r.reply_context_snapshot as Snap).negativeKind ?? "") === "staff_report");
  const noEvidence = staffReport.filter((r) => {
    const head = String((r.reply_context_snapshot as Snap).lastStaffMsgHead ?? "");
    return !STAFF_NEG_RESULT_RE.test(head);
  });
  console.log(`\n=== ② staff_report ${staffReport.length}件のうち、直前のスタッフ送信に否決・募集終了の語が無い ===`);
  console.log(`   **${noEvidence.length}件（${pct(noEvidence.length, staffReport.length)}）**`);
  console.log(`   ⚠ lastStaffMsgHead は先頭だけなので、後ろに語がある通も混ざる（下で実物を読む）`);

  // ③ そのうちお客様が「検討します」系だった通（＝ポジティブな検討中なのにネガ扱い）
  const thinking = noEvidence.filter((r) => {
    const s = r.reply_context_snapshot as Snap;
    return s.isThinkingMsg === true || s.substance?.waitSignal?.yes === true;
  });
  console.log(`\n=== ③ そのうち「検討します」系（前向きな検討中なのにネガ扱い）===`);
  console.log(`   **${thinking.length}件**`);

  // ④ スタッフが直したか（誤判定なら直されているはず）
  const pairs = noEvidence.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim());
  const same = pairs.filter((r) => String(r.ai_draft).trim() === String(r.sent_reply).trim()).length;
  console.log(`\n=== ④ 証拠が無いのにネガ扱いされた通を、スタッフはどうしたか ===`);
  console.log(`   下書きと実送信が揃う ${pairs.length}件 ／ そのまま送った ${same}件（${pct(same, pairs.length)}）`);
  console.log(`   **直した ${pairs.length - same}件（${pct(pairs.length - same, pairs.length)}）**`);

  console.log(`\n=== ⑤ 実物を読む（最大8件）===`);
  for (const r of noEvidence.slice(0, 8)) {
    const s = r.reply_context_snapshot as Snap;
    console.log(`${"─".repeat(76)}`);
    console.log(`   お客様  : ${mask(String(r.customer_message ?? "")).replace(/\n/g, " ／ ").slice(0, 70)}`);
    console.log(`   直前こちら: ${mask(String(s.lastStaffMsgHead ?? "")).replace(/\n/g, " ／ ").slice(0, 80)}`);
    console.log(`   TPO     : ${String(s.tpo_label ?? "-").slice(0, 70)}`);
    console.log(`   AI      : ${mask(String(r.ai_draft ?? "")).replace(/\n/g, " ／ ").slice(0, 90)}`);
    console.log(`   実送信   : ${mask(String(r.sent_reply ?? "")).replace(/\n/g, " ／ ").slice(0, 90)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
