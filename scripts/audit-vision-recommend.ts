// scripts/audit-vision-recommend.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-vision-recommend.ts [--n=4]
//
// 2026-09-20 竹内「物件オススメの画像読み取りの部分 deepseek V4.1 に置き換えても問題ないかテスト」
//
// 物件オススメは**お客様に送る文そのもの**を画像から作る（抽出ではなく生成）。
// 同じ画像・同じ指示で Claude Sonnet5 と DeepSeek-V4.1-Flash に書かせ、
//   ①実送信365日の言い回しにあるか（創作していないか）
//   ②物件の事実（家賃・間取り・築年）が画像と合っているか
//   ③速度・費用
// を比べる。設計知見「生成文と実送信を同じ整形で突き合わせる」。
// 読み取りのみ。
export {};
import { createClient } from "@supabase/supabase-js";
import { extractPhraseShapes } from "../app/lib/phrase-shape";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const N = Number((process.argv.find((a) => a.startsWith("--n=")) ?? "--n=4").split("=")[1]);
const ANTH = (process.env.ANTHROPIC_API_KEY ?? "").trim();
const DSK = (process.env.DEEPSEEK_API_KEY ?? "").trim();

// 物件オススメの骨子（本番の system の要点。長い部分は省いて同じ条件で比べる）
const SYSTEM = `あなたは賃貸仲介のLINE営業担当です。添付の物件資料から、お客様に送るオススメ文を1つ作ってください。

【形】
🌟物件名 号室

1〜2行でこのお部屋の良さ

（オススメポイント）
・家賃〇〇円・共益費〇〇円（合計〇〇円）
・間取り：〇〇
・その他の設備や立地の良さ

【ルール】
・画像に書かれていない事は書かない（金額・築年・設備を作らない）
・「！！」で終える・絵文字は 😊 😌 のみ1〜2個
・「お待たせ致しました」は使わない
・解説や前置きを書かない（送る文だけ）`;

async function claude(url: string) {
  const t0 = Date.now();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTH, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 900, system: SYSTEM, thinking: { type: "disabled" },
      messages: [{ role: "user", content: [
        { type: "text", text: "この物件資料からオススメ文を作ってください。" },
        { type: "image", source: { type: "url", url } },
      ] }] }),
    signal: AbortSignal.timeout(150_000),
  });
  const j = await r.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } };
  return { text: (j.content?.find((b) => b.type === "text")?.text ?? "").trim(), inTok: j.usage?.input_tokens ?? 0, outTok: j.usage?.output_tokens ?? 0, ms: Date.now() - t0 };
}

async function deepseek(url: string) {
  const t0 = Date.now();
  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DSK}` },
    body: JSON.stringify({ model: "deepseek-flash", max_tokens: 8000,
      messages: [{ role: "user", content: [
        { type: "text", text: `${SYSTEM}\n\nこの物件資料からオススメ文を作ってください。` },
        { type: "image_url", image_url: { url } },
      ] }] }),
    signal: AbortSignal.timeout(240_000),
  });
  const j = await r.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
  return { text: String(j.choices?.[0]?.message?.content ?? "").trim(), inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0, ms: Date.now() - t0 };
}

async function loadSent(): Promise<Set<string>> {
  const s = new Set<string>();
  for (let p = 0; ; p++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("id", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null }>;
    if (r.length === 0) break;
    for (const m of r) for (const x of extractPhraseShapes(m.text ?? "")) s.add(x.predicate);
    if (r.length < 1000) break;
    if (p > 14) break;
  }
  return s;
}

const BAD = [
  { label: "お待たせ致しました（禁止語）", re: /お待たせ(?:致しました|しました)/ },
  { label: "作業メモ・箇条書きの記号", re: /^\s*[-*#]|^\s*⚠|```/m },
  { label: "前置き・解説", re: /以下の?とおり|作成しました|いかがでしょうか。$/ },
];

async function main() {
  const sent = await loadSent();
  console.log(`── 実送信365日の言い回し ${sent.size}種類を物差しにする\n`);

  // 物件資料の画像（物件オススメで使う物＝マイソク）
  const { data } = await sb.from("messages").select("image_url, created_at")
    .eq("sender", "staff").not("image_url", "is", null)
    .gte("created_at", new Date(Date.now() - 25 * 86400_000).toISOString())
    .order("created_at", { ascending: false }).limit(60);
  const urls: string[] = [];
  for (const r of (data ?? []) as Array<{ image_url: string }>) {
    const raw = r.image_url.trim();
    const u = raw.startsWith("[") ? (() => { try { return (JSON.parse(raw) as string[])[0]; } catch { return ""; } })() : raw;
    if (u?.startsWith("http") && !urls.includes(u)) urls.push(u);
    if (urls.length >= N) break;
  }

  let cIn = 0, cOut = 0, dIn = 0, dOut = 0, cMs = 0, dMs = 0, cUnseen = 0, dUnseen = 0, cBad = 0, dBad = 0;
  for (let i = 0; i < urls.length; i++) {
    const [c, d] = await Promise.all([claude(urls[i]), deepseek(urls[i])]);
    cIn += c.inTok; cOut += c.outTok; dIn += d.inTok; dOut += d.outTok; cMs += c.ms; dMs += d.ms;
    const cu = extractPhraseShapes(c.text).filter((x) => !sent.has(x.predicate));
    const du = extractPhraseShapes(d.text).filter((x) => !sent.has(x.predicate));
    cUnseen += cu.length; dUnseen += du.length;
    const cb = BAD.filter((b) => b.re.test(c.text)), db = BAD.filter((b) => b.re.test(d.text));
    cBad += cb.length; dBad += db.length;
    console.log(`═══ ${i + 1}枚目 ═══`);
    console.log(`  ─ Claude（${(c.ms / 1000).toFixed(1)}秒・実送信0件の言い回し${cu.length}件${cb.length ? `・${cb.map((x) => x.label).join(",")}` : ""}）`);
    console.log(c.text.split("\n").slice(0, 10).map((l) => `      ${l}`).join("\n"));
    console.log(`  ─ DeepSeek（${(d.ms / 1000).toFixed(1)}秒・実送信0件の言い回し${du.length}件${db.length ? `・${db.map((x) => x.label).join(",")}` : ""}）`);
    console.log(d.text.split("\n").slice(0, 10).map((l) => `      ${l}`).join("\n"));
    for (const u of du.slice(0, 3)) console.log(`      DeepSeek 0件: ${JSON.stringify(u.clause.slice(0, 50))}`);
    console.log("");
  }

  const n = urls.length;
  console.log(`--- まとめ（${n}枚）---`);
  console.log(`  実送信0件の言い回し   Claude ${cUnseen}件 / DeepSeek ${dUnseen}件`);
  console.log(`  体裁の崩れ            Claude ${cBad}件 / DeepSeek ${dBad}件`);
  console.log(`  速度                  Claude ${(cMs / n / 1000).toFixed(1)}秒 / DeepSeek ${(dMs / n / 1000).toFixed(1)}秒`);
  console.log(`  1枚費用               Claude $${(((cIn * 3 + cOut * 15) / 1e6) / n).toFixed(5)} / DeepSeek $${(((dIn * 0.30 + dOut * 1.20) / 1e6) / n).toFixed(5)}`);
  console.log(`  トークン              Claude 入${Math.round(cIn / n)}/出${Math.round(cOut / n)} / DeepSeek 入${Math.round(dIn / n)}/出${Math.round(dOut / n)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
