// 「AI だけが書いて、人間は一度も書かない文」を洗い出す（読み取りのみ）
//
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
// 設計知見「実送信で線を引く」を**逆向き**に使う:
//   スタッフの実送信12,000通に1回も出ないのに、AI の下書きには繰り返し出る文＝**AI の癖**。
//   竹内さんの言う「変な言い回し」はここに集まる。件数だけでなく必ず本文を読む。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const MIN_DRAFT = Number(process.env.MIN ?? 3);   // 下書きに何回以上出たら拾うか
const MIN_LEN = 8;                                 // 短すぎる断片は拾わない

/** 本文を「文」に割る（！！・。・改行で切る。絵文字は文末に残す） */
function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[。！!？?])(?![。！!？?])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_LEN);
}
/** 数字・物件名・人名の違いを無視して「言い回し」だけを比べる */
function normalize(s: string): string {
  return s
    .replace(/[0-9０-９,，]+/g, "#")
    .replace(/【[^】]*】/g, "【】")
    .replace(/[A-Za-zＡ-Ｚａ-ｚ]+/g, "@")
    .replace(/[^\S\n]+/g, "")
    .replace(/[ぁ-んァ-ヶー一-龥]{1,6}さん/g, "〇さん")
    .trim();
}

async function grab(table: "messages" | "ai_reply_examples", col: string) {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const out: string[] = [];
  for (let p = 0; p < 16; p++) {
    const { data } = table === "messages"
      ? await sb.from(table).select(`${col}`).eq("sender", "staff").gte("created_at", since)
          .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999)
      : await sb.from(table).select(`${col}`).gte("created_at", since)
          .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    for (const x of r) { const t = String(x[col] ?? ""); if (t && t !== "__SHOWN__") out.push(t); }
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const sent = await grab("messages", "text");
  const draft = await grab("ai_reply_examples", "ai_draft");
  console.log(`実送信 ${sent.length}通 ／ AI下書き ${draft.length}件\n`);

  const humanForms = new Set<string>();
  for (const t of sent) for (const s of sentences(t)) humanForms.add(normalize(s));

  // 下書きの文を数える（正規化後）。原文も1つ覚えておく
  const aiCount = new Map<string, { n: number; sample: string }>();
  for (const t of draft) {
    const seen = new Set<string>();
    for (const s of sentences(t)) {
      const k = normalize(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const cur = aiCount.get(k) ?? { n: 0, sample: s };
      cur.n++;
      aiCount.set(k, cur);
    }
  }

  const aiOnly = [...aiCount.entries()]
    .filter(([k, v]) => v.n >= MIN_DRAFT && !humanForms.has(k))
    .sort((a, b) => b[1].n - a[1].n);

  console.log(`=== AI の下書きに${MIN_DRAFT}回以上出るのに、実送信には1度も無い言い回し: ${aiOnly.length}種類 ===`);
  console.log(`（人が一度も書かない形＝「変な言い回し」の候補。必ず本文を読んで判断する）\n`);
  for (const [, v] of aiOnly.slice(0, 70)) {
    console.log(`${String(v.n).padStart(3)}回  ${v.sample.replace(/\n/g, " ").slice(0, 110)}`);
  }

  // 参考: 逆（人がよく書くのに AI が書かない）は「足りない物」なので別軸。上位だけ出す
  const aiForms = new Set(aiCount.keys());
  const humanCount = new Map<string, { n: number; sample: string }>();
  for (const t of sent) {
    const seen = new Set<string>();
    for (const s of sentences(t)) {
      const k = normalize(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const cur = humanCount.get(k) ?? { n: 0, sample: s };
      cur.n++;
      humanCount.set(k, cur);
    }
  }
  const humanOnly = [...humanCount.entries()]
    .filter(([k, v]) => v.n >= 25 && !aiForms.has(k))
    .sort((a, b) => b[1].n - a[1].n);
  console.log(`\n=== 逆: 人は25回以上書くのに AI が1度も書かない言い回し: ${humanOnly.length}種類（上位15）===`);
  for (const [, v] of humanOnly.slice(0, 15)) {
    console.log(`${String(v.n).padStart(4)}回  ${v.sample.replace(/\n/g, " ").slice(0, 100)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
