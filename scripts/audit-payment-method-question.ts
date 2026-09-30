// 支払い方法（分割・カード払い・一括・振込のみ）の質問を company-facts の credit_card に当てる線の監査（読み取りのみ）
//
// 2026-09-30 竹内（みこと「初期費用分割は難しいですよね🥲」→ AI「初期費用の分割払いは難しいですが…」）。
//   ① お客様の発言（365日）で、広い候補（分割|一括|カード|クレカ|クレジット|支払|振込|ローン|後払い）を全部並べ、
//      旧の ask（正規表現）と新の matchCompanyFacts（isPaymentMethodQuestion＋not）の当たりを並べて読む
//   ② その質問の次のスタッフの実送信を並べ、答え方（カード払いなら分割・3.24%）が事実と合うか読む
//   ③ スタッフの実送信（365日）に、事実に反する断定（company-fact-guard の credit_card / credit_installment）が何通あるか
//
// 実行: npx tsx --env-file=.env.local scripts/audit-payment-method-question.ts [DAYS=365]
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts } from "../app/lib/company-facts";
import { findCompanyFactContradictionsUngated } from "../app/lib/company-fact-guard";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const one = (s: string) => s.replace(/\s+/g, " ").trim();
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const OLD_ASK = /(?:クレジット|クレカ)(?:カード)?[^。\n]{0,10}(?:払|決済|支払|でき|出来|可能|大丈夫|使え|いけ)|カード(?:払い|決済|で(?:の)?(?:お?支払|払))|分割(?:払い)?[^。\n]{0,8}(?:でき|出来|可能|大丈夫|ですか|いけ)/;
const OLD_NOT = /クレカ(?:系|ブラック)|(?:クレジット|クレカ)(?:カード)?の?(?:滞納|履歴|審査|系|ブラック)|保証会社(?:の|は|が)?(?:審査|滞納|クレ)|同行|代理人/;
const WIDE = /分割|一括|カード|クレカ|クレジット|支払|振込|振り込み|ローン|後払い/;

async function main() {
  const days = Number(process.env.DAYS ?? 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
  const msgs: Msg[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at").order("id").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[]; msgs.push(...r); if (r.length < 1000) break;
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (m.conversation_id === YUMA) continue; const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const cust = msgs.filter((m) => m.conversation_id !== YUMA && m.sender === "customer" && (m.text ?? "").trim() && !/^\s*\[(?:画像|動画|スタンプ|ファイル)\]/.test(m.text ?? ""));
  console.log(`直近${days}日 全${msgs.length}通・お客様の発言 ${cust.length}通\n`);

  const cand = cust.filter((m) => WIDE.test(m.text ?? ""));
  const isNew = (t: string) => matchCompanyFacts(t).some((f) => f.id === "credit_card");
  const isOld = (t: string) => OLD_ASK.test(t) && !OLD_NOT.test(t);
  const nextStaff = (m: Msg) => {
    const a = byConv.get(m.conversation_id) ?? [];
    const i = a.indexOf(m);
    for (let j = i + 1; j < a.length && j < i + 8; j++) if (a[j].sender === "staff" && (a[j].text ?? "").trim()) return one(a[j].text ?? "").slice(0, 110);
    return "（なし）";
  };
  let both = 0, onlyNew = 0, onlyOld = 0;
  console.log(`① 広い候補 ${cand.length}通（新旧の当たりを並べる。[新旧]=両方・[新だけ]・[旧だけ]・[なし]）`);
  for (const m of cand) {
    const t = m.text ?? ""; const n = isNew(t), o = isOld(t);
    if (n && o) both++; else if (n) onlyNew++; else if (o) onlyOld++;
    const tag = n && o ? "新旧" : n ? "新だけ" : o ? "旧だけ" : "なし";
    if (tag === "なし" && !/分割|一括|クレカ|クレジット|カード(?:払|決済|支払)|支払い?方法|振込(?:み)?(?:のみ|だけ|しか)/.test(t)) continue; // 関係の薄い候補は数だけ
    console.log(`  [${tag}] ${m.created_at.slice(0, 10)} ${one(t).slice(0, 90)}`);
    if (n || o) console.log(`        → 次のスタッフ: ${nextStaff(m)}`);
  }
  console.log(`\n  新旧 ${both}・新だけ ${onlyNew}・旧だけ ${onlyOld}・お客様の発言全体に占める新の当たり ${((both + onlyNew) / cust.length * 100).toFixed(3)}%`);

  console.log(`\n③ スタッフの実送信で、支払いの事実に反する断定（出口の形・ゲート無し）`);
  const staff = msgs.filter((m) => m.conversation_id !== YUMA && m.sender === "staff" && (m.text ?? "").trim());
  let hits = 0;
  for (const m of staff) {
    for (const h of findCompanyFactContradictionsUngated(m.text)) {
      if (h.factId !== "credit_card" && h.factId !== "credit_installment") continue;
      hits++; console.log(`  ${m.created_at.slice(0, 16)} [${h.factId}] ${h.sentence.slice(0, 90)}`);
    }
  }
  console.log(`  計 ${hits}通（スタッフ ${staff.length}通中）`);
}
main();
