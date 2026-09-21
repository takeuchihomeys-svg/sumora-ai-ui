// 「お申込みいただきありがとうございます」（申込へのお礼）の出所と線（読み取りのみ）
//
// 2026-09-21 竹内「申込ありがとうございますって申込とは審査の申込みの時に使うものであって、
//   このような場面で使わないから、原因見つける」
//
// ■ 最初に分けて数える
//   実送信20通を読んだら、全部が「これから申し込んでもらう」**依頼**の形だった:
//     「お気に召されましたらお部屋お申込みいただき、ご内覧設定させて頂きます」
//     「お部屋埋まってしまう前にお申込みいただき、お部屋抑えた状態でご内覧いただくのをオススメ」
//   問題の下書きは「お申込みいただき**ありがとうございます**」＝ **済んだことへのお礼**。
//   ＝ 同じ「お申込みいただき」でも**依頼**と**お礼**は別物。混ぜて数えると線が引けない。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-thanks.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 365);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(2)}%` : "-");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

/** 申込が**済んだこと**へのお礼（竹内さんが「この場面で使わない」と言った形） */
const APPLY_THANKS_RE = /お?申込(?:み|)(?:いただき|頂き|下さり|くださり)?(?:誠に)?ありがとう/;
/** これから申し込んでもらう**依頼**（実送信にある正しい形） */
const APPLY_REQUEST_RE = /お?申込(?:み|)(?:いただき|頂き)(?![^。！!\n]{0,6}ありがとう)/;

async function page(days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, customer_message, ai_draft, sent_reply, aix_action, entry_source, reply_context_snapshot, created_at")
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
  console.log(`=== 直近${DAYS}日 実送信 ${sent.length}通 / 下書きあり ${rows.filter((r) => String(r.ai_draft ?? "").trim()).length}件 ===\n`);

  // ① 依頼形とお礼形を分けて数える（線を引く材料）
  const sentThanks = sent.filter((r) => APPLY_THANKS_RE.test(String(r.sent_reply)));
  const sentRequest = sent.filter((r) => APPLY_REQUEST_RE.test(String(r.sent_reply)));
  console.log(`=== ① 「お申込み…」の形を分ける ===`);
  console.log(`   依頼（これから申し込んでもらう）  ${String(sentRequest.length).padStart(4)}通（${pct(sentRequest.length, sent.length)}）`);
  console.log(`   **お礼（申込が済んだこと）**      ${String(sentThanks.length).padStart(4)}通（${pct(sentThanks.length, sent.length)}）`);

  console.log(`\n   ─ お礼形の実送信を全部読む（この形が正しい場面はどこか）─`);
  for (const r of sentThanks.slice(0, 15)) {
    const cm = mask(String(r.customer_message ?? "")).replace(/\n/g, " ／ ").slice(0, 60);
    console.log(`   [${r.aix_action ?? "-"}] お客様: ${cm || "(なし)"}`);
    console.log(`      → ${mask(String(r.sent_reply)).replace(/\n/g, " ／ ").slice(0, 100)}`);
  }

  // ② AI がお礼形を書いた時、スタッフはどうしたか
  const pairs = rows.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim());
  const draftThanks = pairs.filter((r) => APPLY_THANKS_RE.test(String(r.ai_draft)));
  const kept = draftThanks.filter((r) => APPLY_THANKS_RE.test(String(r.sent_reply))).length;
  console.log(`\n=== ② AI がお礼形を書いた時、スタッフはどうしたか ===`);
  console.log(`   下書きと実送信が揃う ${pairs.length}件`);
  console.log(`   AI がお礼形を書いた   ${draftThanks.length}件`);
  console.log(`     残した ${kept}件 ／ **消した ${draftThanks.length - kept}件**`);
  for (const r of draftThanks.slice(0, 6)) {
    console.log(`\n   ── お客様: ${mask(String(r.customer_message ?? "")).replace(/\n/g, " ／ ").slice(0, 70)}`);
    console.log(`      AI    : ${mask(String(r.ai_draft)).replace(/\n/g, " ／ ").slice(0, 100)}`);
    console.log(`      実送信 : ${mask(String(r.sent_reply)).replace(/\n/g, " ／ ").slice(0, 100)}`);
    const rc = (r.reply_context_snapshot ?? {}) as Record<string, unknown>;
    const keys = ["tpoLabel", "scene", "stage", "checkpointStage", "replyMode", "ruleId", "cellId", "conversationState", "status"];
    const shown = keys.filter((k) => rc[k] !== undefined && rc[k] !== null)
      .map((k) => `${k}=${typeof rc[k] === "string" ? rc[k] : JSON.stringify(rc[k])}`);
    if (shown.length) console.log(`      材料  : ${shown.join(" / ").slice(0, 160)}`);
  }

  // ③ お客様が何と言った時にお礼形が出るか（状況の読み違い）
  console.log(`\n=== ③ お礼形が出た時のお客様の一言（状況の読み違いを見る）===`);
  const msgCount = new Map<string, number>();
  for (const r of draftThanks) {
    const m = mask(String(r.customer_message ?? "")).trim().replace(/\n/g, " ").slice(0, 40);
    if (m) msgCount.set(m, (msgCount.get(m) ?? 0) + 1);
  }
  for (const [m, n] of [...msgCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${String(n).padStart(2)}回  「${m}」`);
  }

  // ④ 手本に混ざっていないか（few-shot の汚染）
  const star = rows.filter((r) => APPLY_THANKS_RE.test(String(r.sent_reply ?? "")));
  console.log(`\n=== ④ 手本（実送信）にお礼形が何件あるか ＝ few-shot に混ざる元 ===`);
  console.log(`   ${star.length}件`);
  for (const r of star.slice(0, 8)) {
    console.log(`   [${r.entry_source ?? "-"} / ${r.aix_action ?? "-"}] ${mask(String(r.sent_reply)).replace(/\n/g, " ／ ").slice(0, 90)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
