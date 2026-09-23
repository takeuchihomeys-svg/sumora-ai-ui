// S5（内覧の日程調整）で、同じ発言に対する AI の下書きとスタッフの実送信を**対で**比べる（読み取りのみ）
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして 生成される文にギャップが生まれないか確認する」
//   ai_reply_examples（customer_message / ai_draft / sent_reply）で S5 の問いに当たる行を集め、
//   行の役割（日時・日付・ご都合だけ・改めてご連絡だけ・内覧可能だけ・申込CTA・禁止語・約束の宣言）の率を AI／実送信で並べる。
//   通常返信（aix_action なし）と AIX 由来を分けて見る（AIX の下書きは日時が入っているのが当たり前）。
// 実行: npx tsx --env-file=.env.local scripts/audit-s5-draft-vs-sent.ts [DAYS=180]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);

const S5_ASK = /(内覧|内見|見学)[^\n]{0,14}(でき|出来|可能|いけ|行け|したい|希望|お願い|いつ|何時|時間|日程|都合|大丈夫|空い)|(いつ|何時|明日|本日|今日|今週|来週|土曜|日曜|[0-9０-９]{1,2}日)[^\n]{0,16}(内覧|内見|見学)/;
const S5_NOT = /(キャンセル|ありがとうございました|中止|延期|遅れ|遅刻|向かって|到着|着き)/;
const PORTAL_OCR = /^\s*\[画像\]|内見予約|お問い合わせ\s*$/m;
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました[^）]*）|\[返信不要\])\s*$/;

const HAS_DATETIME = /\d{1,2}\s*[\/／月]\s*\d{1,2}[日]?[^\n]{0,10}\d{1,2}\s*[:：時]|\d{1,2}\s*[:：]\s*\d{2}|(明日|本日|明後日|今週|来週|土曜|日曜|月曜|火曜|水曜|木曜|金曜)[^\n]{0,12}\d{1,2}\s*[:：時]/;
const HAS_DATE = /\d{1,2}\s*[\/／月]\s*\d{1,2}\s*日?|(明日|本日|明後日|今週|来週)[^\n]{0,6}(以降|から|でしたら|ですと|ご案内|可能)/;
const ASK_CONVENIENT = /ご都合[^\n]{0,14}(お日にち|日程|よろしい|いかが|如何)/;
const LATER_ONLY = /(改めて|追って|後ほど|詳細(に|は)[^\n]{0,8})[^\n]{0,14}(ご連絡|ご案内)(させて|いたし|し)|内覧の詳細[^\n]{0,10}ご連絡|(集合場所|待ち合わせ)[^\n]{0,14}改めて/;
const CAN_VIEW = /(ご内覧|内覧|ご案内)[^\n]{0,6}(可能|出来|でき)/;
const APPLY_CTA = /お申込|申込へ|申込み(を|に)|ご契約|審査/;
const BANNED = /お待たせ致しました|お待たせいたしました|全力サポート|全力でサポート|いつでもお気軽/;
const PROMISE = /(確認|お調べ|交渉|調整)(させて(頂|いただ)き|いたし|し)ます/;
const NANITOZO = /何卒/;

type Row = { id: string; conversation_id: string; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; was_ai_used: boolean | null; ai_similarity: number | null; aix_action: string | null; created_at: string };
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("ai_reply_examples").select("id, conversation_id, customer_message, ai_draft, sent_reply, was_ai_used, ai_similarity, aix_action, created_at")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const s5 = rows.filter((r) => {
    const c = r.customer_message ?? "", d = (r.ai_draft ?? "").trim(), s = (r.sent_reply ?? "").trim();
    return r.conversation_id !== YUMA && c && !PORTAL_OCR.test(c) && S5_ASK.test(c) && !S5_NOT.test(c) && d && s && !MARK.test(d) && !MARK.test(s);
  });
  console.log(`=== 直近${DAYS}日・S5 の問いに下書きと実送信が両方ある ${s5.length}件（全体 ${rows.length}件）===`);
  const groups: Array<[string, Row[]]> = [
    ["全体", s5],
    ["通常返信（aix_action なし）", s5.filter((r) => !r.aix_action)],
    ["AIX 由来（viewing_invite / meeting_place）", s5.filter((r) => /viewing_invite|meeting_place/.test(r.aix_action ?? ""))],
    ["AIX 由来（それ以外）", s5.filter((r) => r.aix_action && !/viewing_invite|meeting_place/.test(r.aix_action))],
  ];
  const row = (name: string, xs: Row[], f: (t: string) => boolean) => {
    const d = xs.filter((r) => f(r.ai_draft ?? "")).length, s = xs.filter((r) => f(r.sent_reply ?? "")).length;
    const gap = xs.length ? (d - s) / xs.length * 100 : 0;
    console.log(`     ${name.padEnd(26)} AI ${pct(d, xs.length).padStart(6)} ／ 実送信 ${pct(s, xs.length).padStart(6)} ／ 差 ${(gap >= 0 ? "+" : "") + gap.toFixed(1)}pt${Math.abs(gap) >= 10 ? " ◀ ずれ" : ""}`);
  };
  for (const [name, xs] of groups) {
    if (!xs.length) { console.log(`\n■ ${name}: 0件`); continue; }
    console.log(`\n■ ${name}: ${xs.length}件 ／ そのまま送信 ${pct(xs.filter((r) => r.was_ai_used).length, xs.length)} ／ 似ている度中央値 ${med(xs.map((r) => r.ai_similarity ?? 0)).toFixed(3)}`);
    row("具体的な日時", xs, (t) => HAS_DATETIME.test(t));
    row("日付だけ（日時なし）", xs, (t) => !HAS_DATETIME.test(t) && HAS_DATE.test(t));
    row("ご都合を聞く（日時なし）", xs, (t) => !HAS_DATETIME.test(t) && ASK_CONVENIENT.test(t));
    row("改めて／後ほどご連絡の宣言", xs, (t) => LATER_ONLY.test(t));
    row("内覧可能ですと言う", xs, (t) => CAN_VIEW.test(t));
    row("申込・審査の語", xs, (t) => APPLY_CTA.test(t));
    row("確認／調整しますの宣言", xs, (t) => PROMISE.test(t));
    row("何卒", xs, (t) => NANITOZO.test(t));
    row("禁止語（お待たせ・全力・いつでも）", xs, (t) => BANNED.test(t));
    console.log(`     ${"長さ（字・中央値）".padEnd(26)} AI ${String(med(xs.map((r) => (r.ai_draft ?? "").length))).padStart(6)} ／ 実送信 ${String(med(xs.map((r) => (r.sent_reply ?? "").length))).padStart(6)}`);
    console.log(`     ${"行数（中央値）".padEnd(26)} AI ${String(med(xs.map((r) => (r.ai_draft ?? "").split("\n").filter((l) => l.trim()).length))).padStart(6)} ／ 実送信 ${String(med(xs.map((r) => (r.sent_reply ?? "").split("\n").filter((l) => l.trim()).length))).padStart(6)}`);
  }
  console.log(`\n■ 通常返信で AI が「改めて／後ほどご連絡」だけを書いた実物（実送信と対）`);
  for (const r of s5.filter((r) => !r.aix_action && LATER_ONLY.test(r.ai_draft ?? "")).slice(0, 10)) {
    console.log(`   [${r.created_at.slice(5, 10)} そのまま=${r.was_ai_used ? "はい" : "いいえ"}] 客: ${(r.customer_message ?? "").replace(/\n/g, " / ").slice(0, 70)}`);
    console.log(`      AI    : ${(r.ai_draft ?? "").replace(/\n/g, " / ").slice(0, 150)}`);
    console.log(`      実送信: ${(r.sent_reply ?? "").replace(/\n/g, " / ").slice(0, 150)}`);
  }
  console.log(`\n■ 通常返信で AI が日時も日付も出さず、実送信は日時を出した実物`);
  for (const r of s5.filter((r) => !r.aix_action && !HAS_DATETIME.test(r.ai_draft ?? "") && !HAS_DATE.test(r.ai_draft ?? "") && HAS_DATETIME.test(r.sent_reply ?? "")).slice(0, 8)) {
    console.log(`   [${r.created_at.slice(5, 10)}] 客: ${(r.customer_message ?? "").replace(/\n/g, " / ").slice(0, 70)}`);
    console.log(`      AI    : ${(r.ai_draft ?? "").replace(/\n/g, " / ").slice(0, 150)}`);
    console.log(`      実送信: ${(r.sent_reply ?? "").replace(/\n/g, " / ").slice(0, 150)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
