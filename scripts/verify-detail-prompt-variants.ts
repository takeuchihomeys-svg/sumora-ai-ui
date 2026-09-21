// 引用画像の読み取りが「推論で使い切って答えが出ない」問題の線引き（実測）
//
// 2026-09-21: 最初の実測で 8枚中3枚しか読めず、失敗はすべて out=7999〜8000
//   ＝ max_tokens を推論で使い切っている（property-image-read.ts の【踏んだ罠】と同じ）。
//   ①上限を上げる ②聞き方を簡単にして推論を減らす のどちらが効くかを同じ画像で比べる。
//
// 実行: npx tsx --env-file=.env.local scripts/verify-detail-prompt-variants.ts [--n=5]
import { createClient } from "@supabase/supabase-js";
import { parseDetailResult, PROPERTY_IMAGE_ENDPOINT, PROPERTY_IMAGE_MODEL_DEFAULT } from "../app/lib/property-image-read";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const N = Number(arg("n", "5"));

// A: 今の聞き方（自由に20行まで）
const PROMPT_A = `この画像に**書かれている内容だけ**を書き出してください。JSONのみ返答（説明文・コードブロック一切不要）：
{"kind":"property","lines":["項目: 値", "..."]}
- kind: "property"（物件の資料・マイソク・間取り図・室内写真）／"estimate"（見積書）／"document"（本人確認書類）／"other"
- kind が "property" 以外なら lines は必ず空配列
- lines: 資料に書いてある項目を「項目: 値」の形で。画像に書かれていない項目は行ごと作らない
- 推測しない。画像の文字をそのまま写す
- 行は多くても20行まで`;

// B: 決まった項目だけ（迷う所を無くす＝推論を減らす）
const PROMPT_B = `画像の文字をそのまま写してJSONで返す。説明・コードブロック不要。考え込まずに見えた文字を写すこと。
{"kind":"property","lines":[]}
kind は property（物件資料・マイソク・間取り図）／estimate（見積書）／document（身分証・申込書）／other のどれか。
property 以外は lines を空にする。
property なら、次の項目のうち**画像に書いてある物だけ**を "項目: 値" の形で lines に入れる（書いていない項目は飛ばす・順番はこのまま）:
物件名／号室／所在地／交通／間取り／専有面積／所在階／向き／築年／構造／賃料／管理費／敷金／礼金／駐車場／駐輪場／バイク置場／ペット／楽器／設備／洗濯機置場／現況／入居可能日／契約期間／保証会社／備考`;

async function call(url: string, prompt: string, maxTokens: number, effort: string | null) {
  const t0 = Date.now();
  try {
    const res = await fetch(PROPERTY_IMAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${(process.env.DEEPSEEK_API_KEY ?? "").trim()}` },
      body: JSON.stringify({
        model: PROPERTY_IMAGE_MODEL_DEFAULT,
        max_tokens: maxTokens,
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url } }] }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { ms: Date.now() - t0, lines: 0, kind: `HTTP${res.status}`, out: 0 };
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { completion_tokens?: number } };
    const d = parseDetailResult(String(j.choices?.[0]?.message?.content ?? ""));
    return { ms: Date.now() - t0, lines: d.lines.length, kind: d.kind, out: j.usage?.completion_tokens ?? 0, sample: d.lines.slice(0, 3) };
  } catch (e) {
    return { ms: Date.now() - t0, lines: 0, kind: `ERR:${e instanceof Error ? e.name : "?"}`, out: 0 };
  }
}

/** Claude Haiku Vision（LINE受信画像の書き起こしで実績のある経路）で同じ事を聞く */
async function callClaude(url: string, prompt: string) {
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": (process.env.ANTHROPIC_API_KEY ?? "").trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.VISION_MODEL ?? "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "url", url } },
          { type: "text", text: prompt },
        ] }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return { ms: Date.now() - t0, lines: 0, kind: `HTTP${res.status}`, out: 0, sample: [] as string[] };
    const j = await res.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const d = parseDetailResult(String(j.content?.find((b) => b.type === "text")?.text ?? ""));
    return { ms: Date.now() - t0, lines: d.lines.length, kind: d.kind, out: j.usage?.output_tokens ?? 0, sample: d.lines.slice(0, 3), inTok: j.usage?.input_tokens ?? 0 };
  } catch (e) {
    return { ms: Date.now() - t0, lines: 0, kind: `ERR:${e instanceof Error ? e.name : "?"}`, out: 0, sample: [] as string[] };
  }
}

async function main() {
  // 物件の資料と分かっている画像だけで比べる（見積書は読まない設計なので比較にならない）
  const { data: sip } = await sb.from("sent_image_properties")
    .select("image_url, property_name, created_at").order("created_at", { ascending: false }).limit(60);
  const urls = [...new Set(((sip ?? []) as Array<{ image_url: string }>).map((r) => r.image_url))].slice(0, N);
  const variants: Array<[string, string, number, string | null]> = [
    ["A DeepSeek / 8000 / low", PROMPT_A, 8000, "low"],
    ["B 項目を決める / 16000 / low", PROMPT_B, 16000, "low"],
  ];
  const agg = new Map<string, { ok: number; ms: number; out: number }>();
  for (const url of urls) {
    console.log("═".repeat(70));
    console.log(url.slice(-40));
    for (const [label, prompt, mt, eff] of variants) {
      const r = await call(url, prompt, mt, eff);
      const a = agg.get(label) ?? { ok: 0, ms: 0, out: 0 };
      a.ok += r.lines > 0 ? 1 : 0; a.ms += r.ms; a.out += r.out; agg.set(label, a);
      console.log(`  ${label.padEnd(30)} kind=${String(r.kind).padEnd(9)} 行=${String(r.lines).padStart(2)} ${String(r.ms).padStart(6)}ms out=${r.out}`);
      if (r.sample?.length) console.log(`      ${r.sample.join(" ／ ")}`);
    }
    const c = await callClaude(url, PROMPT_A);
    const a = agg.get("C Claude Haiku / A の聞き方") ?? { ok: 0, ms: 0, out: 0 };
    a.ok += c.lines > 0 ? 1 : 0; a.ms += c.ms; a.out += c.out; agg.set("C Claude Haiku / A の聞き方", a);
    console.log(`  ${"C Claude Haiku / A の聞き方".padEnd(30)} kind=${String(c.kind).padEnd(9)} 行=${String(c.lines).padStart(2)} ${String(c.ms).padStart(6)}ms out=${c.out}`);
    if (c.sample?.length) console.log(`      ${c.sample.join(" ／ ")}`);
  }
  console.log("═".repeat(70));
  for (const [k, v] of agg) console.log(`${k.padEnd(30)} 読めた ${v.ok}/${urls.length}  平均 ${Math.round(v.ms / urls.length)}ms  出力平均 ${Math.round(v.out / urls.length)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
