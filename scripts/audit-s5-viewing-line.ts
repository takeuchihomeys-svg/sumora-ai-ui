// S5（内覧の日程調整）で実送信に線を引く（読み取りのみ・180日）
//
// 問い: お客様が「内見できますか／いつ／何時」と聞いた時、スタッフの返し（3時間以内・次のお客様発言まで）は
//   ①具体的な日時を出す ②日付だけ ③「ご都合よろしいお日にちに」だけ（日時なし） ④「改めてご連絡／詳細は後ほど」の宣言だけ
//   のどれか。AIX 由来（内覧のご案内／待ち合わせ）の割合も。
// 線の決め方（設計知見）: 必須にしてよいのは過半数が守る形だけ／禁止は実送信ほぼ0の形だけ／20%帯は率を渡す。
// 実行: npx tsx --env-file=.env.local scripts/audit-s5-viewing-line.ts [DAYS=180]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);

/** S5 の問い（内覧できるか・いつ・何時）。キャンセル・お礼・感想は外す */
const S5_ASK = /(内覧|内見|見学)[^\n]{0,14}(でき|出来|可能|いけ|行け|したい|希望|お願い|いつ|何時|時間|日程|都合|大丈夫|空い)|(いつ|何時|明日|本日|今日|今週|来週|土曜|日曜|[0-9０-９]{1,2}日)[^\n]{0,16}(内覧|内見|見学)/;
const S5_NOT = /(キャンセル|ありがとうございました|ありがとうございます[^\n]{0,6}$|中止|延期|遅れ|遅刻|向かって|到着|着き)/;
const PORTAL_OCR = /^\s*\[画像\]|内見予約|お問い合わせ\s*$/m;

const HAS_DATETIME = /\d{1,2}\s*[\/／月]\s*\d{1,2}[日]?[^\n]{0,10}\d{1,2}\s*[:：時]|\d{1,2}\s*[:：]\s*\d{2}|(明日|本日|明後日|今週|来週|土曜|日曜|月曜|火曜|水曜|木曜|金曜)[^\n]{0,12}\d{1,2}\s*[:：時]/;
const HAS_DATE = /\d{1,2}\s*[\/／月]\s*\d{1,2}\s*日?|(明日|本日|明後日|今週|来週)[^\n]{0,6}(以降|から|でしたら|ですと|ご案内|可能)/;
const ASK_CONVENIENT = /ご都合[^\n]{0,14}(お日にち|日程|よろしい|いかが|如何)/;
const LATER_ONLY = /(改めて|追って|後ほど|詳細(に|は)[^\n]{0,8})[^\n]{0,14}(ご連絡|ご案内)(させて|いたし|し)|内覧の詳細[^\n]{0,10}ご連絡|(集合場所|待ち合わせ)[^\n]{0,14}改めて/;
const CAN_VIEW = /(ご内覧|内覧|ご案内)[^\n]{0,6}(可能|出来|でき)/;

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null };
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const cand: Msg[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url")
      .eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[];
    for (const m of r) {
      const t = m.text ?? "";
      if (m.conversation_id === YUMA || !t || t.length > 300) continue;
      if (PORTAL_OCR.test(t)) continue;
      if (S5_ASK.test(t) && !S5_NOT.test(t)) cand.push(m);
    }
    if (r.length < 1000) break;
  }
  console.log(`=== 直近${DAYS}日・S5 の問い（お客様） ${cand.length}通 ===`);
  let replied = 0, dt = 0, dateOnly = 0, convOnly = 0, laterOnly = 0, canView = 0, aixVi = 0, aixMp = 0, hand = 0, handDt = 0, other = 0;
  const laterSamples: string[] = [], convSamples: string[] = [], handDtSamples: string[] = [];
  for (const m of cand) {
    const t3 = new Date(Date.parse(m.created_at) + 3 * 3600_000).toISOString();
    const { data } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url")
      .eq("conversation_id", m.conversation_id).gt("created_at", m.created_at).lte("created_at", t3).order("created_at", { ascending: true }).limit(12);
    const after = (data ?? []) as Msg[];
    const replies: Msg[] = [];
    for (const a of after) { if (a.sender === "customer") break; if (a.sender === "staff" && (a.text ?? "").trim() && !/^\s*\[(画像|動画)\]\s*$/.test(a.text ?? "")) replies.push(a); }
    if (!replies.length) continue;
    replied++;
    const joined = replies.map((r) => r.text ?? "").join("\n");
    const anyAix = replies.some((r) => r.is_aix_generated);
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type").eq("conversation_id", m.conversation_id).gte("created_at", m.created_at).lte("created_at", t3);
    const types = ((ax ?? []) as Array<{ aix_type: string }>).map((a) => a.aix_type);
    if (types.includes("viewing_invite")) aixVi++;
    if (types.includes("meeting_place")) aixMp++;
    if (!anyAix && !types.length) { hand++; if (HAS_DATETIME.test(joined)) { handDt++; if (handDtSamples.length < 6) handDtSamples.push(joined.replace(/\n/g, " / ").slice(0, 110)); } }
    if (HAS_DATETIME.test(joined)) dt++;
    else if (HAS_DATE.test(joined)) dateOnly++;
    else if (ASK_CONVENIENT.test(joined)) { convOnly++; if (convSamples.length < 8) convSamples.push(joined.replace(/\n/g, " / ").slice(0, 110)); }
    else if (LATER_ONLY.test(joined)) { laterOnly++; if (laterSamples.length < 10) laterSamples.push(joined.replace(/\n/g, " / ").slice(0, 110)); }
    else if (CAN_VIEW.test(joined)) canView++;
    else other++;
  }
  console.log(`  3時間以内に返した ${replied}通（${pct(replied, cand.length)}）`);
  console.log(`  ① 具体的な日時あり            ${dt}（${pct(dt, replied)}）`);
  console.log(`  ② 日付だけ（◯日以降・明日）   ${dateOnly}（${pct(dateOnly, replied)}）`);
  console.log(`  ③ 「ご都合よろしいお日にち」だけ ${convOnly}（${pct(convOnly, replied)}）`);
  console.log(`  ④ 「改めて／後ほどご連絡」だけ  ${laterOnly}（${pct(laterOnly, replied)}）`);
  console.log(`  ⑤ 「内覧可能です」だけ         ${canView}（${pct(canView, replied)}）`);
  console.log(`  ⑥ その他（別の話題の答え等）    ${other}（${pct(other, replied)}）`);
  console.log(`  AIX: 内覧のご案内 ${aixVi}（${pct(aixVi, replied)}）／ 待ち合わせ ${aixMp}（${pct(aixMp, replied)}）／ 手打ちのみ ${hand}（${pct(hand, replied)}・うち日時あり ${handDt}＝${pct(handDt, hand)}）`);
  console.log(`\n  --- ④ の実物（宣言だけ）---`); for (const s of laterSamples) console.log(`    ${s}`);
  console.log(`\n  --- ③ の実物（ご都合だけ）---`); for (const s of convSamples) console.log(`    ${s}`);
  console.log(`\n  --- 手打ちで日時を出した実物 ---`); for (const s of handDtSamples) console.log(`    ${s}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
