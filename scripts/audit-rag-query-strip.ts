// 検索の問いから定型を落とすと、正解のナレッジが何位に上がるかを実データで測る（読み取りのみ・全件監査）
//
// 2026-09-23 竹内「ちゃんとテストして改善されたか問題ないかも確認する」
//
// 測ること:
//   ① 実データの何%で定型の行が落ちるか（＝効く場面の広さ）
//   ② 落とす前と後で、埋め込みの向きがどれだけ変わるか（変わらないなら効かない）
//   ③ 実際に正解のナレッジの順位が上がるか（OpenAI で両方の埋め込みを作って比べる）
//
// ⚠ ③は OpenAI の埋め込みを作るので少額の費用がかかる（1件0.00002ドル程度）。
// 【結果】入れなかった。実データ14件で前後の順位を比べると 上がった1／下がった4／変わらず7、
//   ブレインの枠(12件)に入った数は 3→2 と減った。対象の多くは申込フォームの記入内容で、
//   定型を落としてもベクトルの向きが変わるだけだった（設計知見「監査で止める」）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-rag-query-strip.ts [N=14]
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
// ⚠ この案は **入れなかった**（下の結果を見る）。関数はここに持つ（app/lib には置かない＝使わないコードを残さない）
const BOILERPLATE_ONLY = new RegExp(
  "^(?:" + [
    "よろしくお願い(?:致します|いたします|します)?", "宜しくお願い(?:致します|いたします|します)?",
    "何卒よろしくお願い(?:致します|いたします|します)?", "ありがとう(?:ございます|ございました|ござます)?",
    "ありがとございます", "お世話になっております", "お世話になります", "かしこまりました",
    "承知(?:致しました|いたしました|しました)", "了解(?:です|しました|致しました)?", "はい",
    "おはようございます", "こんにちは", "こんばんは", "失礼(?:致します|いたします|します)", "すみません", "すいません",
  ].join("|") + ")$",
);
const bare = (line: string) => line
  .replace(/[\s　]/g, "")
  .replace(/[！!？?。、．,～~…・「」『』（）()\[\]【】🙏😊😌😭💦✨🙇♀♂️‍️]/gu, "").trim();
function stripBoilerplateForRag(text: string | null | undefined): { text: string; dropped: number } {
  const src = (text ?? "").trim();
  if (!src) return { text: "", dropped: 0 };
  const kept: string[] = []; let dropped = 0;
  for (const line of src.split(/\r?\n/)) {
    const b = bare(line);
    if (!b || BOILERPLATE_ONLY.test(b)) { dropped++; continue; }
    kept.push(line);
  }
  if (kept.length === 0) return { text: src, dropped: 0 };
  return { text: kept.join("\n"), dropped };
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

async function main() {
  const N = Number(process.env.N ?? 40);
  // ① 実データの何%で落ちるか（直近90日のお客様の発言）
  const { data: msgs } = await sb.from("messages").select("text")
    .eq("sender", "customer").gte("created_at", new Date(Date.now() - 90 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(3000);
  const texts = ((msgs ?? []) as Array<{ text: string | null }>).map((m) => (m.text ?? "").trim()).filter(Boolean);
  const stripped = texts.map((t) => stripBoilerplateForRag(t));
  const hit = stripped.filter((r) => r.dropped > 0);
  console.log(`① 直近90日のお客様の発言 ${texts.length}通`);
  console.log(`   定型の行が落ちた: ${hit.length}通（${pct(hit.length, texts.length)}）／ 落ちた行数の中央値 ${med(hit.map((r) => r.dropped))}`);
  const shorter = texts.map((t, i) => (t.length - stripped[i].text.length) / Math.max(t.length, 1)).filter((v) => v > 0);
  console.log(`   短くなった割合の中央値: ${(med(shorter) * 100).toFixed(1)}%`);

  // ③ 正解のナレッジの順位が上がるか（定型が落ちる発言だけで試す）
  const { data: target } = await sb.from("ai_reply_knowledge")
    .select("id, content, embedding").ilike("content", "%3親等以内の方で緊急連絡先様を設定%").limit(1);
  const tgt = ((target ?? []) as Array<{ id: string; content: string; embedding: unknown }>)[0];
  // ⚠ 対象は「その正解が答えになる発言」に絞る。広く取ると圏外ばかりで差が見えない（最初の監査で踏んだ）。
  //   実際に生成が走った発言（ai_reply_examples.customer_message）を使う＝本番の問いに一番近い。
  const { data: exs } = await sb.from("ai_reply_examples").select("customer_message")
    .ilike("customer_message", "%緊急連絡先%").order("created_at", { ascending: false }).limit(200);
  const cases = [...new Set(((exs ?? []) as Array<{ customer_message: string | null }>)
    .map((e) => (e.customer_message ?? "").trim())
    .filter((t) => t && stripBoilerplateForRag(t).dropped > 0))].slice(0, N);
  console.log(`\n③ 定型が落ちる発言 ${cases.length}件で、正解のナレッジ（3親等以内…）の順位を比べる`);
  if (!tgt || cases.length === 0) { console.log("   対象なし"); return; }

  const rank = async (q: string): Promise<number | null> => {
    const emb = (await openai.embeddings.create({ model: "text-embedding-3-small", input: q })).data[0].embedding;
    const { data, error } = await sb.rpc("match_reply_knowledge", { query_embedding: emb, match_count: 60, min_importance: 8, boost_state: null });
    if (error) return null;
    const list = (data ?? []) as Array<{ id: string }>;
    const i = list.findIndex((r) => r.id === tgt.id);
    return i >= 0 ? i + 1 : null;
  };
  let better = 0, worse = 0, same = 0, inFrame = 0, wasInFrame = 0;
  for (const t of cases.slice(0, Math.min(N, 12))) {
    const before = await rank(t);
    const after = await rank(stripBoilerplateForRag(t).text);
    const b = before ?? 999, a = after ?? 999;
    if (a < b) better++; else if (a > b) worse++; else same++;
    if (b <= 12) wasInFrame++;
    if (a <= 12) inFrame++;
    console.log(`   ${(b === 999 ? "圏外" : `${b}位`).padStart(5)} → ${(a === 999 ? "圏外" : `${a}位`).padStart(5)}  ${t.replace(/\n/g, " / ").slice(0, 52)}`);
  }
  console.log(`\n   上がった ${better} ／ 下がった ${worse} ／ 変わらず ${same}`);
  console.log(`   ブレインの枠（12件）に入った: 前 ${wasInFrame} → 後 ${inFrame}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
