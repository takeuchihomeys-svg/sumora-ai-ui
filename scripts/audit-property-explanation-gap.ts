// scripts/audit-property-explanation-gap.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-property-explanation-gap.ts [--days=180] [--show=6]
//
// 2026-10-06 ⑫ 竹内さん（R への見積書の送付 16:08「…クリーニング費用はご契約時にお支払いの為…貸主様から報酬が出ない物件となりますので、
//   スモ割は出来ませんが仲介手数料33,000円となりますので、最安値の費用でお取引させて頂きます😌！！」）
//   「このように複雑な返信もする事は出来るのか？いまある資料の読み取りなども活用して…実際にスタッフが送っているような正確で具体的なちゃんとした返信を」
// 実送信（スタッフ・AIX）の物件ごとの具体的な説明を種類ごとに拾い、その番の AI の下書き（ai_reply_examples.ai_draft）に同じ説明があったかを数える。
// 落ちた物の出どころを分ける（自動の物差し・最後は目で読む）:
//   (a) 材料はあるのに渡していない（資料の読み sent_image_properties.facts／見積の記録 estimate_records の AD・割引）
//   (c) スタッフしか知らない（管理会社に確認した答え＝「確認させて頂きましたところ」等）
//   (d) 会社の決まり（スモ割・仲介手数料・最安値）が company-facts に無い
// 読み取りのみ。出力は会話の文を含むので共有しない。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "180"));
const show = Number(arg("show", "6"));
const since = new Date(Date.now() - days * 86400_000).toISOString();

export const FACT_KINDS: Array<{ key: string; re: RegExp }> = [
  { key: "クリーニング", re: /クリーニング(?:費用|代|費)/ },
  { key: "鍵交換", re: /鍵(?:の)?交換/ },
  { key: "火災保険", re: /火災保険|家財保険/ },
  { key: "保証会社・保証料", re: /保証会社|保証料/ },
  { key: "24時間サポート", re: /24時間(?:サポート|サービス|安心)|安心(?:サポート|入居)/ },
  { key: "報酬・AD→割引", re: /報酬|スモ割|割引(?:が|は)?(?:出来|でき)(?:ない|ません)/ },
  { key: "仲介手数料の額", re: /仲介手数料[^。\n]{0,8}[0-9,]+円/ },
  { key: "最安値", re: /最安値/ },
  { key: "設備（エアコン等）", re: /エアコン|追い焚き|追焚|宅配ボックス|インターネット(?:無料)?|浴室乾燥|独立洗面/ },
  { key: "入居可能日", re: /(?:ご)?入居(?:可能|頂け|いただけ)|退去予定/ },
  { key: "ペット", re: /ペット(?:可|飼育|相談|不可)/ },
  { key: "審査", re: /審査/ },
];
const MGMT_ANSWER_RE = /確認(?:させて(?:頂|いただ)き|いたし|致し)ました(?:ところ|所)|管理会社(?:に|へ)?確認|とのご(?:返答|回答|連絡)|とのことです/;
const MONEY_RE = /[0-9]{1,3}(?:,[0-9]{3})+円|[0-9]+万円/g;

async function pageAll<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); if (!data?.length) break; out.push(...data); if (data.length < 1000) break; }
  return out;
}

async function main() {
  type Ex = { id: string; conversation_id: string | null; sent_reply: string | null; ai_draft: string | null; entry_source: string | null; aix_action: string | null; created_at: string };
  const ex = await pageAll<Ex>((a, b) => sb.from("ai_reply_examples").select("id, conversation_id, sent_reply, ai_draft, entry_source, aix_action, created_at").gte("created_at", since).not("ai_draft", "is", null).order("created_at").range(a, b));
  const facts = await pageAll<{ conversation_id: string; created_at: string; facts: unknown }>((a, b) => sb.from("sent_image_properties").select("conversation_id, created_at, facts").gte("created_at", since).not("facts", "is", null).range(a, b));
  const est = await pageAll<{ conversation_id: string | null; created_at: string; ad_months: number | null; ad_yen: number | null; discount_yen: number | null; initial_cost_yen: number | null }>((a, b) => sb.from("estimate_records").select("conversation_id, created_at, ad_months, ad_yen, discount_yen, initial_cost_yen").gte("created_at", since).range(a, b));
  const factsByConv = new Map<string, typeof facts>(); for (const f of facts) factsByConv.set(f.conversation_id, [...(factsByConv.get(f.conversation_id) ?? []), f]);
  const estByConv = new Map<string, typeof est>(); for (const e of est) if (e.conversation_id) estByConv.set(e.conversation_id, [...(estByConv.get(e.conversation_id) ?? []), e]);

  const stat: Record<string, { staff: number; aiToo: number; miss: number; a: number; c: number; d: number; ex: string[] }> = {};
  let turns = 0, turnsWithAny = 0, moneyStaff = 0, moneyAiSame = 0, moneyAiInvented = 0;
  for (const e of ex) {
    const sent = String(e.sent_reply ?? ""), draft = String(e.ai_draft ?? "");
    if (!sent || !draft || sent === draft && e.entry_source !== "aix_action") { /* そのまま送った番も数える */ }
    turns++;
    const kinds = FACT_KINDS.filter((k) => k.re.test(sent));
    if (kinds.length) turnsWithAny++;
    // 金額: スタッフの文の金額が下書きにもあるか・下書きにだけある金額（作った数字の疑い）
    const sm = new Set(sent.match(MONEY_RE) ?? []); const dm = new Set(draft.match(MONEY_RE) ?? []);
    if (sm.size) { moneyStaff++; if ([...sm].every((x) => dm.has(x))) moneyAiSame++; }
    if ([...dm].some((x) => !sm.has(x))) moneyAiInvented++;
    const at = Date.parse(e.created_at);
    const hasFacts = !!e.conversation_id && (factsByConv.get(e.conversation_id) ?? []).some((f) => Date.parse(f.created_at) <= at);
    const hasEst = !!e.conversation_id && (estByConv.get(e.conversation_id) ?? []).some((x) => Date.parse(x.created_at) <= at + 10 * 60_000);
    for (const k of kinds) {
      const s = (stat[k.key] ??= { staff: 0, aiToo: 0, miss: 0, a: 0, c: 0, d: 0, ex: [] });
      s.staff++;
      if (k.re.test(draft)) { s.aiToo++; continue; }
      s.miss++;
      // 落ちた物の出どころ（自動の物差し）
      const sentence = sent.split(/\n|(?<=[。！!])/).find((x) => k.re.test(x)) ?? "";
      let why: "a" | "c" | "d";
      if (MGMT_ANSWER_RE.test(sent) && !/報酬|スモ割|仲介手数料|最安値/.test(sentence)) why = "c";
      else if (/報酬|スモ割|仲介手数料|最安値/.test(sentence)) why = hasEst ? "a" : "d";
      else why = hasFacts || hasEst ? "a" : "c";
      s[why]++;
      if (s.ex.length < show) s.ex.push(`${e.created_at.slice(0, 10)} ${e.entry_source ?? "-"}/${e.aix_action ?? "-"} [${why}] 人「${sentence.trim().slice(0, 70)}」 AI「${draft.replace(/\n/g, " / ").slice(0, 60)}」`);
    }
  }
  console.log(`=== 物件ごとの具体的な説明（${days}日・AI の下書きがある番 ${turns}・スタッフが具体的な説明を書いた番 ${turnsWithAny}）===`);
  console.log(`種類 | スタッフが書いた | AI にもあった | 落ちた | (a)材料あり (c)スタッフだけ (d)会社の決まり`);
  for (const [k, s] of Object.entries(stat).sort((a, b) => b[1].staff - a[1].staff)) {
    console.log(`  ${k}: ${s.staff} | ${s.aiToo}（${Math.round((s.aiToo / s.staff) * 100)}%）| ${s.miss} | a${s.a} c${s.c} d${s.d}`);
    for (const x of s.ex) console.log("      " + x);
  }
  console.log(`\n金額: スタッフの文に金額がある番 ${moneyStaff}・下書きに同じ金額が全部ある ${moneyAiSame}（${moneyStaff ? Math.round((moneyAiSame / moneyStaff) * 100) : 0}%）・下書きにだけある金額（作った疑い）の番 ${moneyAiInvented}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
