// 見張りに入っている会話のうち、お客様ではない会話（スタッフ同士・身内・業者・営業）の候補を出す（読み取りのみ・LLM 0）
// 2026-10-07 5巡目（竹内さん「外す」）: 身内・業者の会話を見張りから外す（test-conversations の STAFF_INTERNAL_CONVERSATION_IDS／469a614a と同じ扱い）。
//   見張り（line_watch_turns・既定 30日）の会話ごとに、お客様側・こちら側の文の印を数え、点の高い順に並べる。外すかは竹内さんが決める（一覧を報告に貼る）。
//   印: スタッフ同士の言葉（タメ口の関西弁・笑・社内の語＝AD・元付・レインズ・リアプロ・売上・番長・契約金・鍵渡し・審査通過メール）／
//       業者・営業（御社・弊社のサービス・ご提案・導入・無料・AI・公式LINE・株式会社〜の〜と申します）／
//       身内（おかん・オトン・兄ちゃん・ばあちゃん 等の呼び方・こちらがタメ口）／お客様らしさ（条件フォーム・物件の URL・内覧・申込のフォーマット）
// 実行: npx tsx --env-file=.env.local scripts/audit-internal-conversations.ts [--days=30] [--top=40] [--all]
import { createClient } from "@supabase/supabase-js";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 30);
const TOP = Number(process.argv.find((a) => a.startsWith("--top="))?.split("=")[1] ?? 40);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const one = (s: string | null | undefined, n = 70) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** こちら側（staff）がタメ口・社内の話（お客様への敬語の定型が無い） */
const STAFF_CASUAL_RE = /(?:やん|やで|やねん|ねん[！!。\n]|へん[！!。\n？?]|ちゃう|せな|あかん|しといて|しとく|おとん|おかん|笑$|笑[！!\n]|ｗｗ|かんじ[！!？?]|やろ[！!？?]|いけたら|あつい|もろた)/;
const INTERNAL_WORD_RE = /元付|レインズ|リアプロ|売上番長|番長|AD[0-9０-９]|広告料|仲介料もらう|契約金|鍵渡し|審査通過完了メール|社長|代表に|ノルマ|成約|案件|お疲れ様です[！!]?$/m;
const VENDOR_RE = /御社|貴社|弊社の(?:サービス|システム|ツール)|ご提案させて|導入|無料(?:トライアル|で試)|公式LINE|AI不動産|営業マン|集客|広告(?:運用|代理)|株式会社[^\n]{1,20}の[^\n]{1,10}と申します|お打ち合わせのお時間|資料をお送り/;
const FAMILY_RE = /おかん|オカン|おとん|オトン|兄ちゃん|姉ちゃん|ばあちゃん|じいちゃん|息子よ|娘よ|ママ[〜ー]|パパ[〜ー]/;
const CUSTOMER_LIKE_RE = /①ご入居時期|ご希望家賃|https?:\/\/(?:suumo|www\.homes|www\.athome)|【お申込者様記入欄】|内[覧見]したい|初期費用.{0,6}(?:知りたい|いくら)/;
const STAFF_POLITE_RE = /させて頂きます|させていただきます|お世話になっております|ご査収/;

type M = { conversation_id: string; sender: string; text: string | null; created_at: string };
async function main() {
  const convs = new Set<string>();
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("line_watch_turns").select("conversation_id").gte("customer_turn_at", since).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) convs.add(r.conversation_id as string);
    if ((data ?? []).length < 1000) break;
  }
  // --all: 見張りに入っていない会話も（直近 DAYS 日に発言のある会話）
  if (process.argv.includes("--all")) {
    for (let p = 0; p < 60; p++) {
      const { data } = await sb.from("messages").select("conversation_id").gte("created_at", since).eq("sender", "customer").range(p * 1000, p * 1000 + 999);
      for (const r of data ?? []) convs.add(r.conversation_id as string);
      if ((data ?? []).length < 1000) break;
    }
  }
  const test = new Set(TEST_CONVERSATION_IDS);
  const rows: Array<{ id: string; name: string; score: number; why: string[]; turns: number; sample: string[] }> = [];
  const ids = [...convs];
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from("conversations").select("id, customer_name, line_source_type").in("id", ids.slice(i, i + 100));
    for (const r of data ?? []) names.set(r.id as string, `${r.customer_name ?? ""}${r.line_source_type && r.line_source_type !== "user" ? `（${r.line_source_type}）` : ""}`);
  }
  const turnCount = new Map<string, number>();
  for (let p = 0; p < 20; p++) {
    const { data } = await sb.from("line_watch_turns").select("conversation_id").gte("customer_turn_at", since).range(p * 1000, p * 1000 + 999);
    for (const r of data ?? []) turnCount.set(r.conversation_id as string, (turnCount.get(r.conversation_id as string) ?? 0) + 1);
    if ((data ?? []).length < 1000) break;
  }
  for (const id of ids) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at").eq("conversation_id", id).gte("created_at", new Date(Date.now() - 60 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(200);
    const ms = ((data ?? []) as M[]).filter((m) => (m.text ?? "").trim() && !/^\[(?:画像|動画|スタンプ|ファイル)/.test(m.text ?? ""));
    const staff = ms.filter((m) => m.sender !== "customer"), cust = ms.filter((m) => m.sender === "customer");
    const why: string[] = [];
    let score = 0;
    const sc = staff.filter((m) => STAFF_CASUAL_RE.test(m.text ?? "")).length;
    const sp = staff.filter((m) => STAFF_POLITE_RE.test(m.text ?? "")).length;
    const iw = ms.filter((m) => INTERNAL_WORD_RE.test(m.text ?? "")).length;
    const vd = ms.filter((m) => VENDOR_RE.test(m.text ?? "")).length;
    const fm = ms.filter((m) => FAMILY_RE.test(m.text ?? "")).length;
    const cl = cust.filter((m) => CUSTOMER_LIKE_RE.test(m.text ?? "")).length;
    if (sc) { score += sc * 2; why.push(`こちらのタメ口 ${sc}`); }
    if (staff.length && sp / staff.length < 0.3 && staff.length >= 3) { score += 3; why.push(`こちらの敬語の定型 ${sp}/${staff.length}`); }
    if (iw) { score += iw * 1.5; why.push(`社内の語 ${iw}`); }
    if (vd) { score += vd * 2; why.push(`業者・営業 ${vd}`); }
    if (fm) { score += fm * 2; why.push(`身内の呼び方 ${fm}`); }
    if (cl) { score -= cl * 2; why.push(`お客様らしさ −${cl}`); }
    if (score < 3 || test.has(id)) continue;
    const sample = [...staff.filter((m) => STAFF_CASUAL_RE.test(m.text ?? "") || INTERNAL_WORD_RE.test(m.text ?? "")).slice(0, 2), ...ms.filter((m) => VENDOR_RE.test(m.text ?? "") || FAMILY_RE.test(m.text ?? "")).slice(0, 2), ...cust.slice(0, 1)]
      .slice(0, 3).map((m) => `${m.sender === "customer" ? "客" : "店"}「${one(m.text)}」`);
    rows.push({ id, name: names.get(id) ?? "", score, why, turns: turnCount.get(id) ?? 0, sample });
  }
  rows.sort((a, b) => b.score - a.score);
  console.log(`見張りの会話 ${ids.length}（${DAYS}日）→ 候補 ${rows.length}（点3以上・既に外した ${TEST_CONVERSATION_IDS.length} 件は除く）\n`);
  for (const r of rows.slice(0, TOP)) console.log(`${r.score.toFixed(1).padStart(5)} ${r.id} ${r.name.slice(0, 16)} 番${r.turns}\n      ${r.why.join("・")}\n      ${r.sample.join(" ／ ")}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
